#!/bin/sh
set -eu

runner_root=$(readlink -f "${TAVEN_ORCA_RUNNER_ROOT:-/var/run/taven-orca}")
maximum_artifact_bytes=${TAVEN_SLICER_MAX_ARTIFACT_BYTES:-536870912}
maximum_diagnostic_bytes=${TAVEN_SLICER_MAX_DIAGNOSTIC_BYTES:-1048576}

fail_request() {
  request_directory=$1
  failure_code=$2
  rm -f "$request_directory/processing"
  printf '%s\n' "$failure_code" > "$request_directory/failure-code.tmp"
  mv "$request_directory/failure-code.tmp" "$request_directory/failure-code"
  touch "$request_directory/failed"
}

request_expired() {
  request_directory=$1
  lease=$(cat "$request_directory/lease-expires-at" 2>/dev/null || true)
  case "$lease" in
    ''|*[!0-9]*)
      if [ -f "$request_directory/lease-expires-at" ]; then
        return 0
      fi
      find "$request_directory" -maxdepth 0 -mmin +1 -print -quit | grep -q .
      return
      ;;
  esac
  now=$(date +%s)
  [ "$now" -ge "$lease" ]
}

while true; do
  processed=false
  for request in "$runner_root"/request-*; do
    [ -d "$request" ] || continue

    if [ -f "$request/cancel" ]; then
      rm -rf "$request"
      processed=true
      continue
    fi
    if [ -f "$request/processing" ]; then
      # The loop is synchronous, so a processing marker observed here can only
      # have survived a runner restart. The old container already killed Orca.
      rm -f "$request/processing"
      fail_request "$request" ENGINE_UNAVAILABLE
      processed=true
      continue
    fi
    if [ -f "$request/complete" ] || [ -f "$request/failed" ]; then
      if request_expired "$request"; then
        rm -rf "$request"
        processed=true
      fi
      continue
    fi
    if [ ! -f "$request/ready" ]; then
      if request_expired "$request"; then
        rm -rf "$request"
        processed=true
      fi
      continue
    fi
    if request_expired "$request"; then
      rm -rf "$request"
      processed=true
      continue
    fi
    mv "$request/ready" "$request/processing" 2>/dev/null || continue
    processed=true
    if [ -f "$request/cancel" ]; then
      rm -rf "$request"
      continue
    fi

    copies=$(cat "$request/copies" 2>/dev/null || true)
    artifact_format=$(cat "$request/artifact-format" 2>/dev/null || true)
    timeout_seconds=$(cat "$request/timeout-seconds" 2>/dev/null || true)
    case "$copies" in
      ''|*[!0-9]*) fail_request "$request" ENGINE_UNAVAILABLE; continue ;;
    esac
    case "$timeout_seconds" in
      ''|*[!0-9]*) fail_request "$request" ENGINE_UNAVAILABLE; continue ;;
    esac
    if [ "$copies" -lt 1 ] || [ "$copies" -gt 100000 ] || \
       [ "$timeout_seconds" -lt 1 ] || [ "$timeout_seconds" -gt 1800 ]; then
      fail_request "$request" ENGINE_UNAVAILABLE
      continue
    fi
    case "$artifact_format" in
      gcode) artifact_suffix='*.gcode' ;;
      gcode_3mf) artifact_suffix='*.gcode.3mf' ;;
      *) fail_request "$request" ENGINE_UNAVAILABLE; continue ;;
    esac

    settings=$(find "$request/profiles/settings" -type f -name '*.json' -printf '/work/profiles/settings/%f\n' | LC_ALL=C sort | paste -sd ';' -)
    filaments=$(find "$request/profiles/filaments" -type f -name '*.json' -printf '/work/profiles/filaments/%f\n' | LC_ALL=C sort | paste -sd ';' -)
    if [ -z "$settings" ] || [ ! -f "$request/geometry.stl" ]; then
      fail_request "$request" INVALID_PROFILE
      continue
    fi
    mkdir -p "$request/output" "$request/tmp/data"
    set -- \
      --debug 2 \
      --slice 0 \
      --outputdir /work/output \
      --datadir /tmp/data \
      --load-settings "$settings"
    if [ -n "$filaments" ]; then
      set -- "$@" --load-filaments "$filaments"
    fi
    if [ -f "$request/assembly.json" ]; then
      set -- "$@" --load-assemble-list /work/assembly.json
    elif [ "$copies" -gt 1 ]; then
      set -- "$@" --arrange 1 --clone-objects "$copies"
    fi
    if [ "$artifact_format" = gcode_3mf ]; then
      set -- "$@" --export-3mf toolpath.gcode.3mf --min-save
    fi
    if [ ! -f "$request/assembly.json" ]; then
      set -- "$@" /work/geometry.stl
    fi

    diagnostics_fifo="$request/diagnostics.pipe"
    mkfifo "$diagnostics_fifo"
    /usr/bin/head -c "$maximum_diagnostic_bytes" "$diagnostics_fifo" \
      > "$request/diagnostics" &
    diagnostic_reader_pid=$!
    if /usr/bin/prlimit \
         --as=8589934592 \
         --cpu=1800 \
         --nproc=256 \
         --fsize="$maximum_artifact_bytes" \
         -- /usr/bin/timeout --signal=KILL "$timeout_seconds" \
         /usr/bin/bwrap \
         --unshare-pid \
         --unshare-ipc \
         --unshare-uts \
         --unshare-cgroup-try \
         --die-with-parent \
         --new-session \
         --ro-bind / / \
         --ro-bind "$request" /work \
         --bind "$request/output" /work/output \
         --tmpfs "$runner_root" \
         --bind "$request/tmp" /tmp \
         --proc /proc \
         --dev /dev \
         --chdir /tmp \
         --clearenv \
         --setenv HOME /tmp/home \
         --setenv XDG_CACHE_HOME /tmp/cache \
         --setenv XDG_CONFIG_HOME /tmp/config \
         --setenv XDG_DATA_HOME /tmp/data \
         --setenv LC_ALL C \
         /usr/bin/setpriv \
         --reuid=10001 \
         --regid=10001 \
         --clear-groups \
         --bounding-set=-all \
         --inh-caps=-all \
         --ambient-caps=-all \
         --no-new-privs \
         /opt/orca/AppRun "$@" \
         >"$diagnostics_fifo" 2>&1; then
      engine_status=0
    else
      engine_status=$?
    fi
    wait "$diagnostic_reader_pid" 2>/dev/null || true
    rm -f "$diagnostics_fifo"

    if [ -f "$request/cancel" ]; then
      rm -rf "$request"
      continue
    fi
    diagnostic_bytes=$(wc -c < "$request/diagnostics")
    artifact_count=$(find "$request/output" -type f -name "$artifact_suffix" | wc -l)
    if [ "$engine_status" -eq 0 ] && \
       [ "$artifact_count" -eq 1 ] && \
       [ "$diagnostic_bytes" -lt "$maximum_diagnostic_bytes" ]; then
      rm -f "$request/processing"
      touch "$request/complete"
    else
      rm -rf "$request/output"
      case "$engine_status" in
        126|127) failure_code=ENGINE_UNAVAILABLE ;;
        137) failure_code=ENGINE_TIMEOUT ;;
        141|152|153) failure_code=RESOURCE_LIMIT_EXCEEDED ;;
        *)
          if [ "$diagnostic_bytes" -ge "$maximum_diagnostic_bytes" ]; then
            failure_code=RESOURCE_LIMIT_EXCEEDED
          else
            failure_code=INVALID_GEOMETRY
          fi
          ;;
      esac
      fail_request "$request" "$failure_code"
    fi
  done
  if [ "${TAVEN_ORCA_RUNNER_ONCE:-false}" = true ]; then
    break
  fi
  if [ "$processed" = false ]; then
    sleep 0.1
  fi
done

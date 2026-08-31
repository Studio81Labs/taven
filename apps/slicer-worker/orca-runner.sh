#!/bin/sh
set -eu

runner_root=${TAVEN_ORCA_RUNNER_ROOT:-/var/run/taven-orca}
maximum_artifact_bytes=${TAVEN_SLICER_MAX_ARTIFACT_BYTES:-536870912}
maximum_diagnostic_bytes=${TAVEN_SLICER_MAX_DIAGNOSTIC_BYTES:-1048576}

fail_request() {
  request_directory=$1
  failure_code=$2
  printf '%s\n' "$failure_code" > "$request_directory/failure-code.tmp"
  mv "$request_directory/failure-code.tmp" "$request_directory/failure-code"
  touch "$request_directory/failed"
}

while true; do
  processed=false
  for request in "$runner_root"/request-*; do
    [ -d "$request" ] || continue
    [ -f "$request/ready" ] || continue
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

    settings=$(find "$request/profiles/settings" -type f -name '*.json' -print | LC_ALL=C sort | paste -sd ';' -)
    filaments=$(find "$request/profiles/filaments" -type f -name '*.json' -print | LC_ALL=C sort | paste -sd ';' -)
    if [ -z "$settings" ] || [ ! -f "$request/geometry.stl" ]; then
      fail_request "$request" INVALID_PROFILE
      continue
    fi
    mkdir -p "$request/output" "$request/tmp/data"
    set -- \
      --debug 2 \
      --slice 0 \
      --outputdir "$request/output" \
      --datadir "$request/tmp/data" \
      --load-settings "$settings"
    if [ -n "$filaments" ]; then
      set -- "$@" --load-filaments "$filaments"
    fi
    if [ -f "$request/assembly.json" ]; then
      set -- "$@" --load-assemble-list "$request/assembly.json"
    elif [ "$copies" -gt 1 ]; then
      set -- "$@" --arrange 1 --clone-objects "$copies"
    fi
    if [ "$artifact_format" = gcode_3mf ]; then
      set -- "$@" --export-3mf toolpath.gcode.3mf --min-save
    fi
    if [ ! -f "$request/assembly.json" ]; then
      set -- "$@" "$request/geometry.stl"
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
  if [ "$processed" = false ]; then
    sleep 0.1
  fi
done

#!/bin/sh
set -eu

# Coolify's private Redis CA is the same owner-managed CA used by the other
# staging resources. Prefer slicer-specific names, but accept the backend names
# so one CA value can be reused across the independently managed containers.
cert_path="${TAVEN_REDIS_CA_CERT_PATH:-${TAVEN_DATABASE_CA_CERT_PATH:-/etc/secrets/redis-ca.crt}}"
cert_b64="${TAVEN_REDIS_CA_CERT_B64:-${TAVEN_DATABASE_CA_CERT_B64:-}}"

if [ -n "$cert_b64" ]; then
  cert_dir=$(dirname "$cert_path")
  mkdir -p "$cert_dir"
  umask 077
  printf '%s' "$cert_b64" | base64 -d > "$cert_path"
fi

if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$cert_path" ]; then
  export NODE_EXTRA_CA_CERTS="$cert_path"
fi

exec "$@"

#!/bin/sh
set -eu

database_cert_path="${TAVEN_DATABASE_CA_CERT_PATH:-/etc/secrets/postgres-ca.crt}"
redis_cert_path="${TAVEN_REDIS_CA_CERT_PATH:-/etc/secrets/redis-ca.crt}"

write_cert() {
  cert_path="$1"
  cert_b64="$2"

  if [ -n "$cert_b64" ]; then
    cert_dir=$(dirname "$cert_path")
    mkdir -p "$cert_dir"
    umask 077
    printf '%s' "$cert_b64" | base64 -d > "$cert_path"
  fi
}

write_cert "$database_cert_path" "${TAVEN_DATABASE_CA_CERT_B64:-}"
write_cert "$redis_cert_path" "${TAVEN_REDIS_CA_CERT_B64:-}"

# Node's extra CA setting accepts one PEM bundle. When PostgreSQL and Redis use
# different private CAs, combine both so the same backend image can establish
# TLS connections to both services. An explicitly supplied NODE_EXTRA_CA_CERTS
# remains authoritative for deployments that provide their own bundle.
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ]; then
  if [ -f "$database_cert_path" ] && [ -f "$redis_cert_path" ] &&
    [ "$database_cert_path" != "$redis_cert_path" ]; then
    extra_ca_path="${TAVEN_NODE_EXTRA_CA_CERTS_PATH:-/etc/secrets/node-extra-ca.crt}"
    extra_ca_dir=$(dirname "$extra_ca_path")
    mkdir -p "$extra_ca_dir"
    umask 077
    {
      cat "$database_cert_path"
      printf '\n'
      cat "$redis_cert_path"
    } > "$extra_ca_path"
    export NODE_EXTRA_CA_CERTS="$extra_ca_path"
  elif [ -f "$database_cert_path" ]; then
    export NODE_EXTRA_CA_CERTS="$database_cert_path"
  elif [ -f "$redis_cert_path" ]; then
    export NODE_EXTRA_CA_CERTS="$redis_cert_path"
  fi
fi

if [ "${TAVEN_ENVIRONMENT:-}" = "staging" ] || [ "${TAVEN_ENVIRONMENT:-}" = "production" ]; then
  node <<'EOF'
const databaseUrl = process.env.DATABASE_URL?.trim();

function fail(outcome, sslmode = null) {
  console.error(
    JSON.stringify({
      level: "error",
      ts: new Date().toISOString(),
      event_key: "database.ssl.misconfigured",
      outcome,
      sslmode,
      msg: "DATABASE_URL must use sslmode=verify-full in production",
    }),
  );
  process.exit(1);
}

if (!databaseUrl) fail("missing_database_url");

let sslmode = null;
try {
  const sslmodes = new URL(databaseUrl).searchParams.getAll("sslmode");
  if (sslmodes.length > 1) fail("duplicate_sslmode");
  sslmode = sslmodes[0]?.toLowerCase() ?? null;
} catch {
  fail("invalid_database_url");
}

if (sslmode !== "verify-full") fail("missing_verify_full", sslmode);
EOF
fi

exec "$@"

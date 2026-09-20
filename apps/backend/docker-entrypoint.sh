#!/bin/sh
set -eu

cert_path="${TAVEN_DATABASE_CA_CERT_PATH:-/etc/secrets/postgres-ca.crt}"

if [ -n "${TAVEN_DATABASE_CA_CERT_B64:-}" ]; then
  cert_dir=$(dirname "$cert_path")
  mkdir -p "$cert_dir"
  umask 077
  printf '%s' "$TAVEN_DATABASE_CA_CERT_B64" | base64 -d > "$cert_path"
fi

if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$cert_path" ]; then
  export NODE_EXTRA_CA_CERTS="$cert_path"
fi

if [ "${NODE_ENV:-}" = "production" ]; then
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

import process from "node:process";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

export function validateLocalDatabaseUrl(raw) {
  if (!raw) {
    return "DATABASE_URL is not set";
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return "DATABASE_URL is not a valid URL";
  }

  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    return `DATABASE_URL must use postgres:// or postgresql:// (found ${url.protocol})`;
  }

  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return `DATABASE_URL must target a local PostgreSQL host (found ${url.hostname || "no host"})`;
  }

  return undefined;
}

if (process.argv.includes("--self-test")) {
  const cases = [
    ["postgresql://localhost:5435/db", undefined],
    ["postgres://127.0.0.1:5435/db", undefined],
    ["postgresql://[::1]:5435/db", undefined],
    ["postgresql://db.internal:5432/prod", "local PostgreSQL host"],
    ["postgresql://localhost.evil.example/db", "local PostgreSQL host"],
    ["mysql://user:pass@localhost/db", "must use postgres"],
    ["not a url", "not a valid URL"],
    [undefined, "is not set"],
  ];

  for (const [value, expected] of cases) {
    const actual = validateLocalDatabaseUrl(value);
    if (
      expected === undefined
        ? actual !== undefined
        : !actual?.includes(expected)
    ) {
      throw new Error(
        `unexpected result for ${String(value)}: ${String(actual)}`,
      );
    }
  }

  console.log("local DATABASE_URL self-test passed");
} else {
  const error = validateLocalDatabaseUrl(process.env.DATABASE_URL);
  if (error) {
    console.error(`Refusing to run bootstrap migrations: ${error}.`);
    console.error(
      "Unset the ambient DATABASE_URL or point it at localhost before running pnpm bootstrap.",
    );
    process.exit(1);
  }
  console.log("DATABASE_URL targets local PostgreSQL.");
}

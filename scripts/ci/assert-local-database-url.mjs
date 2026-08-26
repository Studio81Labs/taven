import process from "node:process";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const COMPOSE_DEFAULTS = Object.freeze({
  port: "5435",
  username: "taven",
  database: "taven",
});

export function composeDatabaseIdentity(env = {}) {
  return {
    port: String(env.TAVEN_POSTGRES_PORT ?? COMPOSE_DEFAULTS.port),
    username: String(env.POSTGRES_USER ?? COMPOSE_DEFAULTS.username),
    database: String(env.POSTGRES_DB ?? COMPOSE_DEFAULTS.database),
  };
}

function decodeUrlComponent(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`DATABASE_URL has invalid escaping in its ${label}`);
  }
}

export function validateLocalDatabaseUrl(raw, expected = COMPOSE_DEFAULTS) {
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

  const port = url.port || "5432";
  if (port !== expected.port) {
    return `DATABASE_URL must use the Taven Compose port ${expected.port} (found ${port})`;
  }

  let username;
  let database;
  try {
    username = decodeUrlComponent(url.username, "username");
    database = decodeUrlComponent(
      url.pathname.replace(/^\/+/, ""),
      "database name",
    );
  } catch (error) {
    return error.message;
  }

  if (username !== expected.username) {
    return `DATABASE_URL must use the Taven Compose user ${expected.username} (found ${username || "no user"})`;
  }

  if (database !== expected.database) {
    return `DATABASE_URL must use the Taven Compose database ${expected.database} (found ${database || "no database"})`;
  }

  return undefined;
}

if (process.argv.includes("--self-test")) {
  const defaults = composeDatabaseIdentity();
  const custom = composeDatabaseIdentity({
    TAVEN_POSTGRES_PORT: "5544",
    POSTGRES_USER: "developer",
    POSTGRES_DB: "scratch",
  });
  const cases = [
    ["postgresql://taven:taven@localhost:5435/taven", defaults, undefined],
    ["postgres://taven:taven@127.0.0.1:5435/taven", defaults, undefined],
    ["postgresql://taven:taven@[::1]:5435/taven", defaults, undefined],
    ["postgresql://developer:pw@localhost:5544/scratch", custom, undefined],
    [
      "postgresql://taven:pw@localhost:5432/taven",
      defaults,
      "Compose port 5435",
    ],
    [
      "postgresql://other:pw@localhost:5435/taven",
      defaults,
      "Compose user taven",
    ],
    [
      "postgresql://taven:pw@localhost:5435/other",
      defaults,
      "Compose database taven",
    ],
    [
      "postgresql://taven@db.internal:5435/taven",
      defaults,
      "local PostgreSQL host",
    ],
    [
      "postgresql://taven@localhost.evil.example:5435/taven",
      defaults,
      "local PostgreSQL host",
    ],
    ["mysql://taven:pass@localhost:5435/taven", defaults, "must use postgres"],
    ["not a url", defaults, "not a valid URL"],
    [undefined, defaults, "is not set"],
  ];

  for (const [value, identity, expectedError] of cases) {
    const actual = validateLocalDatabaseUrl(value, identity);
    if (
      expectedError === undefined
        ? actual !== undefined
        : !actual?.includes(expectedError)
    ) {
      throw new Error(
        `unexpected result for ${String(value)}: ${String(actual)}`,
      );
    }
  }

  console.log("local DATABASE_URL self-test passed");
} else {
  const error = validateLocalDatabaseUrl(
    process.env.DATABASE_URL,
    composeDatabaseIdentity(process.env),
  );
  if (error) {
    console.error(`Refusing to run bootstrap migrations: ${error}.`);
    console.error(
      "Unset the ambient DATABASE_URL or match the local Compose port, user, and database before running pnpm bootstrap.",
    );
    process.exit(1);
  }
  console.log("DATABASE_URL matches the local Taven Compose database.");
}

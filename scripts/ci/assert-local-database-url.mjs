import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const LEGACY_LOCAL_DATABASE_URL =
  "postgresql://taven:taven@localhost:5435/taven";
const CURRENT_LOCAL_DATABASE_URL =
  "postgresql://taven:taven@127.0.0.1:5435/taven";
const COMPOSE_DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: "5435",
  username: "taven",
  database: "taven",
});

export function composeDatabaseIdentity(config) {
  const postgres = config?.services?.postgres;
  const binding = postgres?.ports?.find(
    (entry) => String(entry.target) === "5432" && entry.protocol === "tcp",
  );
  const host = normalizeHostname(binding?.host_ip);
  const port = binding?.published;
  const username = postgres?.environment?.POSTGRES_USER;
  const database = postgres?.environment?.POSTGRES_DB;

  if (!host || port == null || username == null || database == null) {
    throw new Error(
      "rendered Compose config is missing the postgres host binding, port, user, or database",
    );
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `rendered Compose postgres must bind to a loopback host (found ${host})`,
    );
  }

  return {
    host,
    port: String(port),
    username: String(username),
    database: String(database),
  };
}

function normalizeHostname(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

export function migrateLegacyLocalDatabaseUrl(raw) {
  const legacyLine = `DATABASE_URL=${LEGACY_LOCAL_DATABASE_URL}`;
  const currentLine = `DATABASE_URL=${CURRENT_LOCAL_DATABASE_URL}`;
  const lines = raw.split(/(?<=\n)/);
  let changed = false;
  const contents = lines
    .map((line) => {
      const ending = line.endsWith("\r\n")
        ? "\r\n"
        : line.endsWith("\n")
          ? "\n"
          : "";
      const body = ending ? line.slice(0, -ending.length) : line;
      if (body !== legacyLine) {
        return line;
      }
      changed = true;
      return `${currentLine}${ending}`;
    })
    .join("");
  return { changed, contents };
}

function decodeUrlComponent(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`DATABASE_URL has invalid escaping in its ${label}`);
  }
}

async function readStdin() {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
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

  const hostname = normalizeHostname(url.hostname);
  if (!LOOPBACK_HOSTS.has(hostname)) {
    return `DATABASE_URL must target a local PostgreSQL host (found ${url.hostname || "no host"})`;
  }
  if (hostname !== expected.host) {
    return `DATABASE_URL must use the Taven Compose host ${expected.host} (found ${hostname})`;
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

  const unsupportedParameters = [...url.searchParams.keys()].filter(
    (parameter) => parameter !== "schema",
  );
  if (unsupportedParameters.length > 0) {
    return `DATABASE_URL may only use the schema query parameter (found ${[...new Set(unsupportedParameters)].join(", ")})`;
  }

  const schemas = url.searchParams.getAll("schema");
  if (schemas.length > 1 || schemas.some((schema) => schema !== "public")) {
    return `DATABASE_URL must use the default PostgreSQL schema public (found ${schemas.join(", ") || "no schema"})`;
  }

  return undefined;
}

if (process.argv.includes("--self-test")) {
  const defaults = COMPOSE_DEFAULTS;
  const custom = composeDatabaseIdentity({
    services: {
      postgres: {
        environment: {
          POSTGRES_USER: "developer",
          POSTGRES_DB: "scratch",
        },
        ports: [
          {
            host_ip: "127.0.0.1",
            target: 5432,
            published: "5544",
            protocol: "tcp",
          },
        ],
      },
    },
  });
  const cases = [
    ["postgres://taven:taven@127.0.0.1:5435/taven", defaults, undefined],
    [
      "postgresql://taven:taven@localhost:5435/taven",
      defaults,
      "Compose host 127.0.0.1",
    ],
    [
      "postgresql://taven:taven@[::1]:5435/taven",
      defaults,
      "Compose host 127.0.0.1",
    ],
    ["postgresql://developer:pw@127.0.0.1:5544/scratch", custom, undefined],
    [
      "postgresql://taven:pw@127.0.0.1:5432/taven",
      defaults,
      "Compose port 5435",
    ],
    [
      "postgresql://other:pw@127.0.0.1:5435/taven",
      defaults,
      "Compose user taven",
    ],
    [
      "postgresql://taven:pw@127.0.0.1:5435/other",
      defaults,
      "Compose database taven",
    ],
    [
      "postgresql://taven:pw@127.0.0.1:5435/taven?schema=other_project",
      defaults,
      "default PostgreSQL schema public",
    ],
    [
      "postgresql://taven:pw@127.0.0.1:5435/taven?schema=public",
      defaults,
      undefined,
    ],
    [
      "postgresql://taven:pw@127.0.0.1:5435/taven?host=/var/run/postgresql",
      defaults,
      "may only use the schema query parameter",
    ],
    [
      "postgresql://taven:pw@127.0.0.1:5435/taven?schema=public&port=5432",
      defaults,
      "may only use the schema query parameter",
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
    ["mysql://taven:pass@127.0.0.1:5435/taven", defaults, "must use postgres"],
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

  const migratedLf = migrateLegacyLocalDatabaseUrl(
    `PORT=3001\nDATABASE_URL=${LEGACY_LOCAL_DATABASE_URL}\n`,
  );
  if (
    !migratedLf.changed ||
    migratedLf.contents !==
      `PORT=3001\nDATABASE_URL=${CURRENT_LOCAL_DATABASE_URL}\n`
  ) {
    throw new Error("legacy LF DATABASE_URL was not migrated exactly");
  }
  const migratedCrlf = migrateLegacyLocalDatabaseUrl(
    `DATABASE_URL=${LEGACY_LOCAL_DATABASE_URL}\r\nPORT=3001\r\n`,
  );
  if (
    !migratedCrlf.changed ||
    migratedCrlf.contents !==
      `DATABASE_URL=${CURRENT_LOCAL_DATABASE_URL}\r\nPORT=3001\r\n`
  ) {
    throw new Error("legacy CRLF DATABASE_URL migration changed line endings");
  }
  const customEnv =
    "DATABASE_URL=postgresql://developer:pw@localhost:5544/custom\n";
  const untouched = migrateLegacyLocalDatabaseUrl(customEnv);
  if (untouched.changed || untouched.contents !== customEnv) {
    throw new Error("a custom DATABASE_URL must never be migrated");
  }

  console.log("local DATABASE_URL self-test passed");
} else if (
  process.argv.some((argument) => argument.startsWith("--migrate-env-file="))
) {
  const argument = process.argv.find((value) =>
    value.startsWith("--migrate-env-file="),
  );
  const path = argument.slice("--migrate-env-file=".length);
  if (!path) {
    console.error("--migrate-env-file requires a path");
    process.exit(1);
  }
  try {
    const original = await readFile(path, "utf8");
    const migrated = migrateLegacyLocalDatabaseUrl(original);
    if (migrated.changed) {
      await writeFile(path, migrated.contents, "utf8");
      console.log(`Migrated the legacy local DATABASE_URL in ${path}.`);
    }
  } catch (error) {
    console.error(
      `Could not migrate the legacy local DATABASE_URL in ${path}: ${error.message}`,
    );
    process.exit(1);
  }
} else {
  let identity;
  try {
    if (!process.argv.includes("--compose-config-stdin")) {
      throw new Error("rendered Compose config must be provided on stdin");
    }
    identity = composeDatabaseIdentity(JSON.parse(await readStdin()));
  } catch (error) {
    console.error(`Refusing to run bootstrap migrations: ${error.message}.`);
    process.exit(1);
  }

  const error = validateLocalDatabaseUrl(process.env.DATABASE_URL, identity);
  if (error) {
    console.error(`Refusing to run bootstrap migrations: ${error}.`);
    console.error(
      "Unset the ambient DATABASE_URL or match the local Compose host, port, user, and database before running pnpm bootstrap.",
    );
    process.exit(1);
  }
  console.log("DATABASE_URL matches the local Taven Compose database.");
}

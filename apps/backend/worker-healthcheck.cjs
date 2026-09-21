"use strict";
const fs = require("node:fs");
const net = require("node:net");
const tls = require("node:tls");
const { createRequire } = require("node:module");
const load = createRequire(process.cwd() + "/package.json");
const deadline = setTimeout(() => {
  console.error("Worker dependency check timed out");
  process.exit(1);
}, 10000);
function redisPing() {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.TAVEN_REDIS_URL);
    const secure = u.protocol === "rediss:";
    if (!secure && u.protocol !== "redis:")
      return reject(new Error("Redis scheme"));
    const options = {
      host: u.hostname,
      port: Number(u.port || (secure ? 6380 : 6379)),
    };
    if (secure) {
      options.servername = u.hostname;
      options.rejectUnauthorized = true;
      const ca = process.env.TAVEN_REDIS_CA_CERT_PATH;
      if (ca && fs.existsSync(ca)) options.ca = fs.readFileSync(ca);
    }
    const socket = secure ? tls.connect(options) : net.connect(options);
    let response = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.setTimeout(3000, () => finish(new Error("Redis timeout")));
    socket.once("error", () => finish(new Error("Redis connection or TLS")));
    const resp = (parts) =>
      "*" +
      parts.length +
      "\r\n" +
      parts
        .map((p) => "$" + Buffer.byteLength(p) + "\r\n" + p + "\r\n")
        .join("");
    socket.once(secure ? "secureConnect" : "connect", () => {
      const password = decodeURIComponent(u.password);
      const username = decodeURIComponent(u.username);
      const auth = password
        ? resp(username ? ["AUTH", username, password] : ["AUTH", password])
        : "";
      socket.write(auth + resp(["PING"]));
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("-") || response.length > 2048)
        return finish(new Error("Redis authentication or response"));
      if (response.includes("+PONG\r\n")) finish();
    });
  });
}
async function main() {
  // init:true makes PID 1 tini; require a real Node worker, not its wrapper.
  const workers = new Set([
    "dist/checkout-payment-worker.js",
    "dist/operator-auth-expiry-worker.js",
    "dist/balance-payment-deadline-worker.js",
    "dist/resource-reservation-expiry-worker.js",
    "dist/retention-worker.js",
    "dist/slicing-dispatch-worker.js",
  ]);
  const found = fs
    .readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .some((pid) => {
      try {
        const args = fs
          .readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .split("\0");
        return /(^|\/)node$/.test(args[0]) && workers.has(args[1]);
      } catch {
        return false;
      } // A process can exit while /proc is being inspected.
    });
  if (!found) throw new Error("Expected worker process missing");
  const { Client } = load("pg");
  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  try {
    await db.connect();
    await db.query("SELECT 1");
  } catch {
    throw new Error("Database connection or query");
  } finally {
    await db.end().catch(() => {});
  }
  if (process.env.TAVEN_REDIS_URL) await redisPing();
  if (!process.env.TAVEN_S3_ENDPOINT) return;
  const { S3Client, HeadBucketCommand } = load("@aws-sdk/client-s3");
  const s3 = new S3Client({
    endpoint: process.env.TAVEN_S3_ENDPOINT,
    region: process.env.TAVEN_S3_REGION,
    forcePathStyle: process.env.TAVEN_S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: process.env.TAVEN_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.TAVEN_S3_SECRET_ACCESS_KEY,
    },
    maxAttempts: 1,
  });
  try {
    await s3.send(
      new HeadBucketCommand({ Bucket: process.env.TAVEN_S3_BUCKET }),
    );
  } catch {
    throw new Error("Object storage access");
  } finally {
    s3.destroy();
  }
}
main()
  .then(() => {
    clearTimeout(deadline);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });

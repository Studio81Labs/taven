import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawn } from "node:child_process";

const webDir = path.resolve(import.meta.dirname, "..");
const outputFixtureServer = path.join(
  webDir,
  ".output-fixture/server/index.mjs",
);

if (
  !existsSync(outputFixtureServer) ||
  process.env.SKIP_FIXTURE_BUILD !== "true"
) {
  console.log("Building fixture server bundle to ensure freshness...");
  execFileSync("node", [path.join(webDir, "scripts/build-fixture-web.mjs")], {
    cwd: webDir,
    stdio: "inherit",
    env: process.env,
  });
}

const apiBaseUrl =
  process.env.NUXT_API_BASE_URL ||
  process.env.NUXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:4175";
const siteUrl = process.env.NUXT_PUBLIC_SITE_URL || "http://127.0.0.1:4174";

const env = {
  ...process.env,
  PORT: process.env.PORT || "4174",
  HOST: process.env.HOST || "127.0.0.1",
  NUXT_API_BASE_URL: apiBaseUrl,
  NUXT_PUBLIC_API_BASE_URL: apiBaseUrl,
  NUXT_PUBLIC_SITE_URL: siteUrl,
  NUXT_PUBLIC_AUTOMATIC_QUOTE_ENABLED: "true",
};

console.log(
  `Starting fixture web server on ${env.HOST}:${env.PORT} (API: ${apiBaseUrl})...`,
);
const server = spawn("node", [outputFixtureServer], {
  cwd: webDir,
  env,
  stdio: "inherit",
});

process.on("SIGINT", () => {
  server.kill("SIGINT");
});
process.on("SIGTERM", () => {
  server.kill("SIGTERM");
});
server.on("error", (err) => {
  console.error("Fixture web server child process error:", err);
});
server.on("exit", (code, signal) => {
  console.log(`Fixture web server exited with code ${code}, signal ${signal}`);
  process.exit(code ?? 0);
});

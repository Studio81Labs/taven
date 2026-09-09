import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function expectOccurrences(sourceText, expression, count, error) {
  const actual = sourceText.split(expression).length - 1;
  if (actual !== count) errors.push(`${error}; found ${actual}`);
}

function environment(sourceText) {
  return new Map(
    sourceText
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=", 2))
      .filter(([name, value]) => name && value !== undefined),
  );
}

const lock = JSON.parse(
  await source("tools/slicing-fixtures/runtime.lock.json"),
);
const expectedImageSha256 = lock.image.ociDigest.replace(/^sha256:/u, "");
const errors = [];

if (!/^[a-z0-9-]+$/u.test(lock.engine.name)) {
  errors.push("runtime.lock.json engine.name must be a canonical engine name");
}
if (!/^\d+\.\d+\.\d+$/u.test(lock.engine.version)) {
  errors.push("runtime.lock.json engine.version must be a semantic version");
}
if (!/^[a-f0-9]{64}$/u.test(expectedImageSha256)) {
  errors.push("runtime.lock.json image.ociDigest must be a SHA-256 digest");
}

const workerConfig = await source("apps/slicer-worker/src/config.ts");
for (const [field, expression] of [
  ["engine name", "const PINNED_ORCA_NAME = runtimeLock.engine.name"],
  ["engine version", "const PINNED_ORCA_VERSION = runtimeLock.engine.version"],
  [
    "engine image digest",
    "const DEFAULT_ORCA_IMAGE_SHA256 = runtimeLock.image.ociDigest.replace(",
  ],
]) {
  if (!workerConfig.includes(expression)) {
    errors.push(
      `apps/slicer-worker/src/config.ts does not derive ${field} from runtime.lock.json`,
    );
  }
}
for (const [expression, error] of [
  [
    "name: PINNED_ORCA_NAME,",
    "apps/slicer-worker/src/config.ts does not use the pinned name in WorkerConfig.engine",
  ],
  [
    "version: pinnedOrcaVersion(env.TAVEN_ORCA_VERSION),",
    "apps/slicer-worker/src/config.ts does not use the pinned version in WorkerConfig.engine",
  ],
]) {
  expectOccurrences(workerConfig, expression, 1, error);
}
if (
  !/imageSha256:\s*sha256\(\s*env\.TAVEN_ORCA_IMAGE_SHA256,\s*DEFAULT_ORCA_IMAGE_SHA256,/u.test(
    workerConfig,
  )
) {
  errors.push(
    "apps/slicer-worker/src/config.ts does not use the pinned image digest in WorkerConfig.engine",
  );
}

const workerDockerfile = await source("apps/slicer-worker/Dockerfile");
if (
  !workerDockerfile.includes(
    "COPY --from=build --chown=10001:10001 /workspace/tools/slicing-fixtures/runtime.lock.json /opt/tools/slicing-fixtures/runtime.lock.json",
  )
) {
  errors.push(
    "apps/slicer-worker/Dockerfile does not copy runtime.lock.json for the compiled worker",
  );
}

const env = environment(await source("apps/slicer-worker/.env.example"));
for (const [name, expected] of [
  ["TAVEN_ORCA_VERSION", lock.engine.version],
  ["TAVEN_ORCA_IMAGE_SHA256", expectedImageSha256],
]) {
  if (env.get(name) !== expected) {
    errors.push(
      `apps/slicer-worker/.env.example ${name} does not match runtime.lock.json`,
    );
  }
}

const seed = await source("apps/backend/scripts/seed.ts");
for (const expression of [
  "const pinnedSlicerEngine = runtimeLock.engine.name;",
  "const pinnedSlicerVersion = runtimeLock.engine.version;",
]) {
  if (!seed.includes(expression)) {
    errors.push(
      `apps/backend/scripts/seed.ts does not derive its identity from runtime.lock.json (${expression})`,
    );
  }
}
for (const [expression, error] of [
  [
    "slicerEngine: pinnedSlicerEngine,",
    "apps/backend/scripts/seed.ts does not use the pinned engine in both seeded profile assignments",
  ],
  [
    "slicerVersion: pinnedSlicerVersion,",
    "apps/backend/scripts/seed.ts does not use the pinned version in both seeded profile assignments",
  ],
]) {
  expectOccurrences(seed, expression, 2, error);
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(
  `Pinned slicer identity is aligned: ${lock.engine.name} ${lock.engine.version} sha256:${expectedImageSha256}`,
);

import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fixtureRoot } from "./profile-lib.mjs";

const printDigest = process.argv.includes("--print-digest");
const noCache = process.argv.includes("--no-cache");
const repositoryRoot = path.resolve(fixtureRoot, "..", "..");
const lock = JSON.parse(
  await readFile(path.join(fixtureRoot, "runtime.lock.json"), "utf8"),
);
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "taven-orca-build-"),
);
const metadataPath = path.join(temporaryDirectory, "metadata.json");

const build = spawnSync(
  "docker",
  [
    "buildx",
    "build",
    "--file",
    "apps/slicer-worker/Orca.Dockerfile",
    "--platform",
    lock.platform,
    "--provenance=false",
    "--sbom=false",
    ...(noCache ? ["--no-cache"] : []),
    "--build-arg",
    `SOURCE_DATE_EPOCH=${lock.sourceDateEpoch}`,
    "--metadata-file",
    metadataPath,
    "--tag",
    lock.image.tag,
    "--load",
    ".",
  ],
  { cwd: repositoryRoot, encoding: "utf8", stdio: "inherit" },
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
const digest = metadata["containerimage.digest"];
if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) {
  throw new Error("BuildKit did not return an OCI image digest");
}

const inspect = spawnSync(
  "docker",
  ["image", "inspect", lock.image.tag, "--format", "{{json .}}"],
  { encoding: "utf8" },
);
if (inspect.status !== 0) {
  throw new Error(inspect.stderr || "Unable to inspect the built Orca image");
}
const image = JSON.parse(inspect.stdout);
const failures = [];
if (image.Architecture !== "amd64" || image.Os !== "linux") {
  failures.push(`platform is ${image.Os}/${image.Architecture}`);
}
if (image.Config.User !== "10001:10001") {
  failures.push(`runtime user is ${image.Config.User || "root"}`);
}
if (image.Config.ExposedPorts) {
  failures.push("runtime exposes a network port");
}
if (
  image.Config.Labels?.["org.opencontainers.image.revision"] !==
  lock.engine.sourceRevision
) {
  failures.push("source revision label does not match the runtime lock");
}
if (failures.length > 0) {
  throw new Error(`Invalid Orca runtime: ${failures.join("; ")}`);
}

if (!printDigest && digest !== lock.image.ociDigest) {
  throw new Error(
    `OCI digest drift: expected ${lock.image.ociDigest}, built ${digest}. Review the image diff and update runtime.lock.json deliberately.`,
  );
}
console.log(
  `${printDigest ? "Built" : "Verified"} ${lock.image.tag} at ${digest}.`,
);

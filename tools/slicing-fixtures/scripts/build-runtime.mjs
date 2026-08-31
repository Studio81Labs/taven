import { mkdtemp, readFile } from "node:fs/promises";
import { rmSync } from "node:fs";
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
process.on("exit", () => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});
const metadataPath = path.join(temporaryDirectory, "metadata.json");
const ociArchivePath = path.join(temporaryDirectory, "runtime.oci.tar");
const builder = spawnSync("docker", ["buildx", "inspect"], {
  encoding: "utf8",
});
if (builder.status !== 0) {
  throw new Error(
    builder.stderr || "Unable to inspect the active Buildx builder",
  );
}
const builderDriver = builder.stdout.match(/^Driver:\s+(\S+)$/m)?.[1];
if (builderDriver !== "docker-container") {
  throw new Error(
    `The reproducibility build requires the pinned docker-container builder used by CI; the active driver is ${builderDriver ?? "unknown"}. Follow tools/slicing-fixtures/README.md to configure it.`,
  );
}
const ubuntuIndexInspect = spawnSync(
  "docker",
  ["buildx", "imagetools", "inspect", "--raw", lock.ubuntu.image],
  { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
);
if (ubuntuIndexInspect.status !== 0) {
  throw new Error(
    ubuntuIndexInspect.stderr || "Unable to inspect the locked Ubuntu image",
  );
}
const ubuntuIndex = JSON.parse(ubuntuIndexInspect.stdout);
const ubuntuAmd64Manifest = ubuntuIndex.manifests?.find(
  (manifest) =>
    manifest.platform?.os === "linux" &&
    manifest.platform?.architecture === "amd64",
);
if (ubuntuAmd64Manifest?.digest !== lock.ubuntu.amd64ManifestDigest) {
  throw new Error(
    `Ubuntu amd64 manifest drift: expected ${lock.ubuntu.amd64ManifestDigest}, resolved ${ubuntuAmd64Manifest?.digest ?? "none"}`,
  );
}
const buildArguments = [
  ["SOURCE_DATE_EPOCH", lock.sourceDateEpoch],
  ["UBUNTU_IMAGE", lock.ubuntu.image],
  ["UBUNTU_SNAPSHOT", lock.ubuntu.packageSnapshot],
  ["ORCA_APPIMAGE_URL", lock.appImage.url],
  ["ORCA_APPIMAGE_SHA256", lock.appImage.sha256],
  ["ORCA_APPIMAGE_SIZE", lock.appImage.size],
  ["ORCA_SQUASHFS_OFFSET", lock.appImage.squashfsOffset],
].flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]);

const commonBuildOptions = [
  "--file",
  "apps/slicer-worker/Orca.Dockerfile",
  "--platform",
  lock.platform,
  "--provenance=false",
  "--sbom=false",
  ...buildArguments,
];
const canonicalBuild = spawnSync(
  "docker",
  [
    "buildx",
    "build",
    ...commonBuildOptions,
    ...(noCache ? ["--no-cache"] : []),
    "--metadata-file",
    metadataPath,
    "--tag",
    lock.image.tag,
    "--output",
    `type=oci,dest=${ociArchivePath},compression=gzip,compression-level=6,force-compression=true,rewrite-timestamp=true`,
    ".",
  ],
  { cwd: repositoryRoot, encoding: "utf8", stdio: "inherit" },
);
if (canonicalBuild.status !== 0) {
  process.exit(canonicalBuild.status ?? 1);
}

const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
const digest = metadata["containerimage.digest"];
if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) {
  throw new Error("BuildKit did not return an OCI image digest");
}

const loadBuild = spawnSync(
  "docker",
  [
    "buildx",
    "build",
    ...commonBuildOptions,
    "--tag",
    lock.image.tag,
    "--load",
    ".",
  ],
  { cwd: repositoryRoot, encoding: "utf8", stdio: "inherit" },
);
if (loadBuild.status !== 0) {
  process.exit(loadBuild.status ?? 1);
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
if (
  image.Config.Labels?.["org.opencontainers.image.version"] !==
  lock.engine.version
) {
  failures.push("engine version label does not match the runtime lock");
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

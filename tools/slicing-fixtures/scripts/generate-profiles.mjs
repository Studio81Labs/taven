import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildProfileBundle, fixtureRoot, stableJson } from "./profile-lib.mjs";

const mode = process.argv[2] ?? "--check";
if (!new Set(["--check", "--write"]).has(mode)) {
  throw new Error("Usage: generate-profiles.mjs [--check|--write]");
}

const { manifest, resolvedProfiles } = await buildProfileBundle();
const resolvedDirectory = path.join(fixtureRoot, "profiles", "resolved");
const manifestPath = path.join(fixtureRoot, "profiles", "manifest.json");
const expectedFiles = [
  [manifestPath, stableJson(manifest)],
  ...resolvedProfiles.map((profile) => [
    path.join(resolvedDirectory, profile.file),
    profile.contents,
  ]),
];
const expectedResolvedFiles = new Set(
  resolvedProfiles.map((profile) => profile.file),
);

async function findUnexpectedResolvedFiles() {
  let entries;
  try {
    entries = await readdir(resolvedDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => !expectedResolvedFiles.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

if (mode === "--write") {
  await mkdir(resolvedDirectory, { recursive: true });
  const unexpectedFiles = await findUnexpectedResolvedFiles();
  await Promise.all(
    unexpectedFiles.map((file) =>
      rm(path.join(resolvedDirectory, file), { recursive: true, force: true }),
    ),
  );
  await Promise.all(
    expectedFiles.map(([file, contents]) => writeFile(file, contents)),
  );
  console.log(`Wrote profile bundle ${manifest.bundleSha256}.`);
} else {
  const drift = [];
  const unexpectedFiles = await findUnexpectedResolvedFiles();
  drift.push(
    ...unexpectedFiles.map((file) => path.join("profiles", "resolved", file)),
  );
  for (const [file, expected] of expectedFiles) {
    let actual;
    try {
      actual = await readFile(file, "utf8");
    } catch {
      drift.push(path.relative(fixtureRoot, file));
      continue;
    }
    if (actual !== expected) {
      drift.push(path.relative(fixtureRoot, file));
    }
  }

  if (drift.length > 0) {
    throw new Error(
      `Resolved profile bundle is stale: ${drift.join(", ")}. Run pnpm slicer-worker:profiles:update.`,
    );
  }
  console.log(`Profile bundle ${manifest.bundleSha256} is current.`);
}

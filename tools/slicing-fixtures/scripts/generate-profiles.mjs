import { mkdir, readFile, writeFile } from "node:fs/promises";
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

if (mode === "--write") {
  await mkdir(resolvedDirectory, { recursive: true });
  await Promise.all(
    expectedFiles.map(([file, contents]) => writeFile(file, contents)),
  );
  console.log(`Wrote profile bundle ${manifest.bundleSha256}.`);
} else {
  const drift = [];
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

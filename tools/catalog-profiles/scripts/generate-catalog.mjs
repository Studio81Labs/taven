import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProfileBundle,
  fixtureRoot,
  stableJson,
} from "../../slicing-fixtures/scripts/profile-lib.mjs";

const mode = process.argv[2] ?? "--check";
if (!new Set(["--check", "--write"]).has(mode)) {
  throw new Error("Usage: generate-catalog.mjs [--check|--write]");
}

const catalogRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputDirectory = path.join(catalogRoot, "resolved");
const { manifest, resolvedProfiles } = await buildProfileBundle({
  sources: [
    {
      directory: path.join(fixtureRoot, "profiles", "source"),
      pathPrefix: "slicing-fixtures",
    },
    {
      directory: path.join(catalogRoot, "source"),
      pathPrefix: "catalog-profiles",
    },
  ],
  roots: [
    {
      kind: "machine",
      name: "Bambu Lab H2S 0.4 nozzle",
      file: "machine.json",
    },
    {
      kind: "process",
      name: "0.20mm Standard @BBL H2S",
      file: "process.json",
    },
    {
      kind: "filament",
      name: "Generic PLA @BBL H2S",
      file: "filament-pla.json",
    },
    {
      kind: "filament",
      name: "Generic PETG @BBL H2S",
      file: "filament-petg.json",
    },
  ],
});
const expectedFiles = [
  [path.join(catalogRoot, "manifest.json"), stableJson(manifest)],
  ...resolvedProfiles.map((profile) => [
    path.join(outputDirectory, profile.file),
    profile.contents,
  ]),
];
const expectedOutput = new Set(resolvedProfiles.map(({ file }) => file));

async function unexpectedFiles() {
  try {
    return (await readdir(outputDirectory))
      .filter((file) => !expectedOutput.has(file))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

if (mode === "--write") {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    (await unexpectedFiles()).map((file) =>
      rm(path.join(outputDirectory, file), { force: true }),
    ),
  );
  await Promise.all(
    expectedFiles.map(([file, contents]) => writeFile(file, contents)),
  );
  console.log(`Wrote catalog profile bundle ${manifest.bundleSha256}.`);
} else {
  const drift = [
    ...(await unexpectedFiles()).map((file) => path.join("resolved", file)),
  ];
  for (const [file, expected] of expectedFiles) {
    try {
      if ((await readFile(file, "utf8")) !== expected) {
        drift.push(path.relative(catalogRoot, file));
      }
    } catch {
      drift.push(path.relative(catalogRoot, file));
    }
  }
  if (drift.length > 0) {
    throw new Error(
      `Catalog profile closure is stale: ${drift.join(", ")}. Run pnpm catalog-profiles:update.`,
    );
  }
  console.log(`Catalog profile bundle ${manifest.bundleSha256} is current.`);
}

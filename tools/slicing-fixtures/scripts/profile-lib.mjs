import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const profileRoots = [
  { kind: "machine", name: "Bambu Lab H2S 0.4 nozzle" },
  { kind: "filament", name: "Generic PLA @BBL H2S" },
  { kind: "process", name: "0.20mm Standard @BBL H2S" },
];

export const upstreamProfileRevision =
  "8500fcdccaa10b5099ac20d252af3a7c560046f1";

function compareUtf16(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function canonicalJson(value, depth = 0) {
  const indentation = "  ".repeat(depth);
  const nestedIndentation = "  ".repeat(depth + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return `[\n${value
      .map((child) => `${nestedIndentation}${canonicalJson(child, depth + 1)}`)
      .join(",\n")}\n${indentation}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      compareUtf16(left, right),
    );
    if (entries.length === 0) {
      return "{}";
    }
    return `{\n${entries
      .map(
        ([key, child]) =>
          `${nestedIndentation}${JSON.stringify(key)}: ${canonicalJson(
            child,
            depth + 1,
          )}`,
      )
      .join(",\n")}\n${indentation}}`;
  }

  return JSON.stringify(value);
}

export function stableJson(value) {
  return `${canonicalJson(value)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function listJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) =>
    compareUtf16(left.name, right.name),
  )) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(candidate)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(candidate);
    }
  }

  return files;
}

function inheritedNames(profile) {
  if (!profile.inherits) {
    return [];
  }

  return Array.isArray(profile.inherits)
    ? profile.inherits
    : [profile.inherits];
}

export async function buildProfileBundle() {
  const sourceDirectory = path.join(fixtureRoot, "profiles", "source");
  const files = await listJsonFiles(sourceDirectory);
  const profiles = new Map();
  const sourceFiles = [];

  for (const file of files) {
    const relativePath = path
      .relative(sourceDirectory, file)
      .replaceAll(path.sep, "/");
    const source = await readFile(file, "utf8");
    const profile = JSON.parse(source);
    if (typeof profile.name !== "string" || profile.name.length === 0) {
      throw new Error(`Profile ${relativePath} has no name`);
    }
    if (profiles.has(profile.name)) {
      throw new Error(`Duplicate profile name: ${profile.name}`);
    }
    profiles.set(profile.name, { profile, relativePath });
    sourceFiles.push({ path: relativePath, sha256: sha256(source) });
  }

  const resolvedByName = new Map();
  const resolving = new Set();
  const usedNames = new Set();

  function resolve(name) {
    const cached = resolvedByName.get(name);
    if (cached) {
      usedNames.add(name);
      return cached;
    }
    const entry = profiles.get(name);
    if (!entry) {
      throw new Error(`Missing inherited profile: ${name}`);
    }
    if (resolving.has(name)) {
      throw new Error(`Profile inheritance cycle at ${name}`);
    }

    resolving.add(name);
    let resolved = {};
    for (const parent of inheritedNames(entry.profile)) {
      resolved = { ...resolved, ...resolve(parent) };
    }
    resolved = { ...resolved, ...entry.profile };
    delete resolved.inherits;
    resolving.delete(name);
    resolvedByName.set(name, resolved);
    usedNames.add(name);
    return resolved;
  }

  const resolvedProfiles = profileRoots.map(({ kind, name }) => {
    const contents = stableJson(resolve(name));
    return {
      kind,
      name,
      file: `${kind}.json`,
      contents,
      sha256: sha256(contents),
    };
  });

  const unused = [...profiles.keys()].filter((name) => !usedNames.has(name));
  if (unused.length > 0) {
    throw new Error(
      `Vendored profiles outside the resolved closure: ${unused.join(", ")}`,
    );
  }

  const manifestWithoutDigest = {
    schemaVersion: 1,
    upstream: {
      project: "OrcaSlicer/OrcaSlicer",
      revision: upstreamProfileRevision,
      sourcePath: "resources/profiles/BBL",
      license: "AGPL-3.0",
    },
    roots: profileRoots,
    sourceFiles,
    resolvedProfiles: resolvedProfiles.map(
      ({ contents: _contents, ...profile }) => profile,
    ),
  };
  const bundleSha256 = sha256(stableJson(manifestWithoutDigest));

  return {
    manifest: { ...manifestWithoutDigest, bundleSha256 },
    resolvedProfiles,
  };
}

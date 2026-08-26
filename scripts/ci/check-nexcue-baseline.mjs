import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const siblingRoot = path.resolve(
  repoRoot,
  process.env.NEXCUE_REPO_PATH ?? "../nexcue",
);
const errors = [];

const read = (root, file) => readFile(path.join(root, file), "utf8");
const readJson = async (root, file) => JSON.parse(await read(root, file));
const readJsonc = async (root, file) =>
  JSON.parse((await read(root, file)).replace(/^\s*\/\/.*$/gm, ""));

const [tavenPackage, nexcuePackage, tavenTs, nexcueTs] = await Promise.all([
  readJson(repoRoot, "package.json"),
  readJson(siblingRoot, "package.json"),
  readJsonc(repoRoot, "tsconfig.base.json"),
  readJsonc(siblingRoot, "tsconfig.base.json"),
]);

for (const key of ["packageManager", "engines"]) {
  if (
    JSON.stringify(tavenPackage[key]) !== JSON.stringify(nexcuePackage[key])
  ) {
    errors.push(`package.json ${key} differs from Nexcue`);
  }
}

if (
  JSON.stringify(tavenTs.compilerOptions) !==
  JSON.stringify(nexcueTs.compilerOptions)
) {
  errors.push("tsconfig.base.json compilerOptions differ from Nexcue");
}

if ((await read(repoRoot, ".nvmrc")) !== (await read(siblingRoot, ".nvmrc"))) {
  errors.push(".nvmrc differs from Nexcue");
}

const postureValue = (source, key) =>
  source.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
const [tavenWorkspace, nexcueWorkspace] = await Promise.all([
  read(repoRoot, "pnpm-workspace.yaml"),
  read(siblingRoot, "pnpm-workspace.yaml"),
]);

for (const key of ["minimumReleaseAge", "blockExoticSubdeps", "trustPolicy"]) {
  if (
    postureValue(tavenWorkspace, key) !== postureValue(nexcueWorkspace, key)
  ) {
    errors.push(`pnpm-workspace.yaml ${key} differs from Nexcue`);
  }
}

async function actionPins(root) {
  const workflowDir = path.join(root, ".github/workflows");
  const files = (await readdir(workflowDir)).filter((file) =>
    /\.ya?ml$/.test(file),
  );
  const pins = new Map();

  for (const file of files) {
    const source = await readFile(path.join(workflowDir, file), "utf8");
    for (const match of source.matchAll(
      /^\s*-\s+uses:\s+([^@\s]+)@([^\s#]+)/gm,
    )) {
      const [, action, pin] = match;
      const values = pins.get(action) ?? new Set();
      values.add(pin);
      pins.set(action, values);
    }
  }
  return pins;
}

const [tavenPins, nexcuePins] = await Promise.all([
  actionPins(repoRoot),
  actionPins(siblingRoot),
]);

for (const [action, pins] of tavenPins) {
  const siblingPins = nexcuePins.get(action);
  if (!siblingPins) continue;
  if ([...pins].sort().join(",") !== [...siblingPins].sort().join(",")) {
    errors.push(
      `${action} pins differ (Taven: ${[...pins].join(", ")}; Nexcue: ${[
        ...siblingPins,
      ].join(", ")})`,
    );
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Nexcue infrastructure baseline matches (${siblingRoot}).`);

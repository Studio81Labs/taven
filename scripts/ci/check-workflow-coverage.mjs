import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const errors = [];

const pathFilteredWorkflows = {
  "backend-ci.yml": [
    "apps/backend/**",
    "packages/core/**",
    "packages/slicer-contracts/**",
    "scripts/ci/check-boundaries.mjs",
  ],
  "web-ci.yml": [
    "apps/web/**",
    "packages/openapi-client/**",
    "packages/ui-web/**",
  ],
  "admin-ci.yml": [
    "apps/admin/**",
    "apps/backend/**",
    "packages/openapi/**",
    "packages/openapi-client/**",
    "packages/ui-web/**",
  ],
  "slicer-worker-ci.yml": [
    "apps/slicer-worker/**",
    "apps/backend/scripts/seed.ts",
    "infra/**",
    "packages/slicer-contracts/**",
    "scripts/ci/check-boundaries.mjs",
    "scripts/ci/check-workflow-coverage.mjs",
    "tools/slicing-fixtures/**",
    "tools/catalog-profiles/**",
    ".dockerignore",
  ],
  "packages-ci.yml": ["packages/**"],
  "openapi-check.yml": [
    "apps/backend/**",
    "packages/openapi/**",
    "packages/openapi-client/**",
  ],
};

const sharedInputs = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".nvmrc",
];

const requiredWorkflows = [
  "format-check.yml",
  "lint-pr.yml",
  "security-scan.yml",
  "labeler.yml",
  "cleanup-pr-caches.yml",
  "prune-stale-caches.yml",
  "sibling-drift.yml",
];

async function requireWorkflow(file, tokens) {
  const relativePath = `.github/workflows/${file}`;
  let source;
  try {
    source = await readFile(path.join(repoRoot, relativePath), "utf8");
  } catch {
    errors.push(`${relativePath} is missing`);
    return;
  }

  for (const token of tokens) {
    if (!source.includes(token)) {
      errors.push(`${relativePath} does not cover '${token}'`);
    }
  }

  for (const trigger of ["pull_request:", "push:"]) {
    if (!source.includes(trigger)) {
      errors.push(`${relativePath} is missing the ${trigger} trigger`);
    }
  }
}

for (const [file, ownedPaths] of Object.entries(pathFilteredWorkflows)) {
  await requireWorkflow(file, [...ownedPaths, ...sharedInputs]);
}

for (const file of requiredWorkflows) {
  try {
    await access(path.join(repoRoot, ".github/workflows", file));
  } catch {
    errors.push(`.github/workflows/${file} is missing`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log("Workflow coverage is valid.");

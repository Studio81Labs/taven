import {
  cpSync,
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const webDir = path.resolve(import.meta.dirname, "..");
const fixtureBuildDir = path.join(webDir, ".fixture-build");
const outputFixtureDir = path.join(webDir, ".output-fixture");

console.log("Preparing fixture build workspace...");
rmSync(fixtureBuildDir, { recursive: true, force: true });
rmSync(outputFixtureDir, { recursive: true, force: true });
mkdirSync(fixtureBuildDir, { recursive: true });

// Directories and files to copy
const entriesToCopy = [
  "assets",
  "components",
  "composables",
  "content",
  "layouts",
  "middleware",
  "pages",
  "plugins",
  "server",
  "utils",
  "app.vue",
  "error.vue",
  "nuxt.config.ts",
  "tsconfig.json",
  "package.json",
];

for (const entry of entriesToCopy) {
  const src = path.join(webDir, entry);
  const dest = path.join(fixtureBuildDir, entry);
  cpSync(src, dest, { recursive: true });
}

// Symlink node_modules
symlinkSync(
  path.join(webDir, "node_modules"),
  path.join(fixtureBuildDir, "node_modules"),
  "junction",
);

// Inject synthetic approved manifest matching backend test catalog
const approvalsContent = `export type CommercialContentStatus = "pending-approval" | "approved";

export const commercialContentApproval = {
  status: "approved" as CommercialContentStatus,
} as const;
`;

const manifestContent = `import {
  legalDrafts,
  type LegalDraftSection,
} from "./legal-drafts";

export type LegalDocumentKey =
  | "terms"
  | "claims"
  | "privacy"
  | "prohibitedContent"
  | "retention"
  | "photoConsent";

export type LegalDocumentSection = LegalDraftSection;

export type LegalDocumentBase = Readonly<{
  id: string;
  path: string;
  title: string;
  summary: string;
  sections: readonly LegalDocumentSection[];
}>;

export type DraftLegalDocument = LegalDocumentBase &
  Readonly<{
    status: "draft";
    effectiveAt: null;
    approvalEvidence: null;
  }>;

export type ApprovedLegalDocument = LegalDocumentBase &
  Readonly<{
    status: "approved";
    effectiveAt: string;
    approvalEvidence: string;
  }>;

export type LegalDocument = DraftLegalDocument | ApprovedLegalDocument;

const CANONICAL_EFFECTIVE_INSTANT =
  /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/;

function effectiveInstantTimestamp(value: string): number | null {
  if (!CANONICAL_EFFECTIVE_INSTANT.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? timestamp : null;
}

export function approvedLegalDocument(
  input: LegalDocumentBase &
    Readonly<{ effectiveAt: string; approvalEvidence: string }>,
): ApprovedLegalDocument {
  return { ...input, status: "approved" };
}

export type LegalDocumentApprovalState =
  | Pick<DraftLegalDocument, "status" | "effectiveAt">
  | Pick<ApprovedLegalDocument, "status" | "effectiveAt">;

export function isEffectiveApprovedLegalDocument(
  document: LegalDocumentApprovalState,
  now?: number,
): boolean {
  if (document.status !== "approved") return false;
  const timestamp = effectiveInstantTimestamp(document.effectiveAt);
  return timestamp !== null && typeof now === "number" && timestamp <= now;
}

const fixtureDocument = (
  key: LegalDocumentKey,
  id: string,
  path: string,
  title: string,
  summary: string,
): ApprovedLegalDocument => ({
  id,
  path,
  title,
  summary,
  sections: legalDrafts[key].sections,
  status: "approved",
  effectiveAt: "2000-01-01T00:00:00.000Z",
  approvalEvidence: "test fixture",
});

export const legalDocuments: Readonly<Record<LegalDocumentKey, LegalDocument>> = {
  terms: fixtureDocument(
    "terms",
    "terms-test-v1",
    "/vop",
    "Obchodní podmínky",
    "Testovací obchodní podmínky pro fixture prostředí.",
  ),
  claims: fixtureDocument(
    "claims",
    "claims-test-v1",
    "/reklamace",
    "Reklamační řád",
    "Testovací reklamační řád pro fixture prostředí.",
  ),
  privacy: fixtureDocument(
    "privacy",
    "privacy-test-v1",
    "/ochrana-soukromi",
    "Zásady ochrany soukromí",
    "Testovací zásady ochrany soukromí pro fixture prostředí.",
  ),
  prohibitedContent: fixtureDocument(
    "prohibitedContent",
    "prohibited-content-test-v1",
    "/zakazany-obsah",
    "Pravidla pro zakázaný obsah",
    "Testovací pravidla zakázaného obsahu pro fixture prostředí.",
  ),
  retention: fixtureDocument(
    "retention",
    "retention-test-v1",
    "/uchovani-dat",
    "Pravidla uchování dat",
    "Testovací pravidla uchování dat pro fixture prostředí.",
  ),
  photoConsent: fixtureDocument(
    "photoConsent",
    "photo-consent-test-v1",
    "/fotografie-a-duvernost",
    "Fotografie a důvěrnost modelů",
    "Testovací pravidla pro fotografie a důvěrnost.",
  ),
};
`;

writeFileSync(
  path.join(fixtureBuildDir, "content/launch-approvals.ts"),
  approvalsContent,
  "utf8",
);
writeFileSync(
  path.join(fixtureBuildDir, "content/launch-manifest.ts"),
  manifestContent,
  "utf8",
);

console.log("Building fixture Nuxt application...");
try {
  execFileSync("pnpm", ["exec", "nuxt", "build"], {
    cwd: fixtureBuildDir,
    env: process.env,
    stdio: "inherit",
  });
  console.log("Typechecking fixture Nuxt application...");
  execFileSync("pnpm", ["exec", "nuxt", "typecheck"], {
    cwd: fixtureBuildDir,
    env: process.env,
    stdio: "inherit",
  });
  const builtOutput = path.join(fixtureBuildDir, ".output");
  if (existsSync(builtOutput)) {
    cpSync(builtOutput, outputFixtureDir, { recursive: true });
    console.log("Fixture build complete: output at", outputFixtureDir);
  } else {
    throw new Error("Nuxt build did not produce .output in " + fixtureBuildDir);
  }
} finally {
  rmSync(fixtureBuildDir, { recursive: true, force: true });
}

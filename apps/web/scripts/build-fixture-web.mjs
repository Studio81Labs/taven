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

const termsRevision = process.env.TAVEN_TERMS_REVISION || "terms-test-v1";
const claimPolicyRevision =
  process.env.TAVEN_CLAIM_POLICY_REVISION || "claims-test-v1";
const photoConsentRevision =
  process.env.TAVEN_PHOTO_CONSENT_REVISION || "photo-consent-test-v1";

const manifestContent = `import type {
  LegalDocument,
  LegalDocumentKey,
  LegalDocumentSection,
} from "./launch-manifest";

const fixtureDocument = (
  id: string,
  path: string,
  title: string,
  summary: string,
  sections: readonly LegalDocumentSection[],
): LegalDocument => ({
  id,
  path,
  title,
  summary,
  sections,
  status: "approved",
  effectiveAt: "2000-01-01T00:00:00.000Z",
  approvalEvidence: "test fixture",
});

export const legalDocuments: Readonly<Record<LegalDocumentKey, LegalDocument>> = {
  terms: fixtureDocument(
    ${JSON.stringify(termsRevision)},
    "/vop",
    "Obchodní podmínky",
    "Testovací obchodní podmínky pro fixture prostředí.",
    [{ title: "Základní ustanovení", paragraphs: ["Testovací znění obchodních podmínek."] }],
  ),
  claims: fixtureDocument(
    ${JSON.stringify(claimPolicyRevision)},
    "/reklamace",
    "Reklamační řád",
    "Testovací reklamační řád pro fixture prostředí.",
    [{ title: "Uplatnění reklamace", paragraphs: ["Testovací znění reklamačního řádu."] }],
  ),
  privacy: fixtureDocument(
    "privacy-test-v1",
    "/ochrana-soukromi",
    "Zásady ochrany soukromí",
    "Testovací zásady ochrany soukromí pro fixture prostředí.",
    [{ title: "Správce údajů", paragraphs: ["Testovací znění zásad ochrany soukromí."] }],
  ),
  prohibitedContent: fixtureDocument(
    "prohibited-content-test-v1",
    "/zakazany-obsah",
    "Pravidla pro zakázaný obsah",
    "Testovací pravidla zakázaného obsahu pro fixture prostředí.",
    [{ title: "Zakázané předměty", paragraphs: ["Testovací pravidla zakázaného obsahu."] }],
  ),
  retention: fixtureDocument(
    "retention-test-v1",
    "/uchovani-dat",
    "Pravidla uchování dat",
    "Testovací pravidla uchování dat pro fixture prostředí.",
    [{ title: "Doba uchování", paragraphs: ["Testovací pravidla uchování dat."] }],
  ),
  photoConsent: fixtureDocument(
    ${JSON.stringify(photoConsentRevision)},
    "/fotografie-a-duvernost",
    "Fotografie a důvěrnost modelů",
    "Testovací pravidla pro fotografie a důvěrnost.",
    [{ title: "Souhlas s fotografiemi", paragraphs: ["Testovací pravidla pro fotografie a důvěrnost."] }],
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

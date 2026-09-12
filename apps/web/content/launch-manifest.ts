import { legalDrafts, type LegalDraftSection } from "./legal-drafts";

export type LegalDocumentKey =
  | "terms"
  | "claims"
  | "privacy"
  | "prohibitedContent"
  | "retention"
  | "photoConsent";

type LegalDocumentBase = Readonly<{
  id: string;
  path: string;
  title: string;
  summary: string;
  sections: readonly LegalDraftSection[];
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

const NON_PRODUCTION_REVISION = /(?:^|[-_.\s])(draft|pending)(?:$|[-_.\s])/i;
const CANONICAL_EFFECTIVE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function effectiveDateTimestamp(value: string): number | null {
  if (!CANONICAL_EFFECTIVE_DATE.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null;
}

export function approvedLegalDocument(
  input: LegalDocumentBase &
    Readonly<{ effectiveAt: string; approvalEvidence: string }>,
): ApprovedLegalDocument {
  if (
    !input.id.trim() ||
    NON_PRODUCTION_REVISION.test(input.id) ||
    effectiveDateTimestamp(input.effectiveAt) === null ||
    !input.approvalEvidence.trim()
  ) {
    throw new TypeError(
      "Approved legal documents require an ID, effective date, and approval evidence",
    );
  }
  return { ...input, status: "approved" };
}

export type LegalDocumentApprovalState =
  | Pick<DraftLegalDocument, "status" | "effectiveAt">
  | Pick<ApprovedLegalDocument, "status" | "effectiveAt">;

export function isEffectiveApprovedLegalDocument(
  document: LegalDocumentApprovalState,
  now = Date.now(),
): boolean {
  if (document.status !== "approved") return false;
  const timestamp = effectiveDateTimestamp(document.effectiveAt);
  return timestamp !== null && timestamp <= now;
}

const documentMetadata = {
  terms: {
    path: "/vop",
    title: "Všeobecné obchodní podmínky",
    summary: "Schválené všeobecné obchodní podmínky zatím nejsou k dispozici.",
  },
  claims: {
    path: "/reklamace",
    title: "Reklamační řád",
    summary: "Schválený reklamační řád zatím není k dispozici.",
  },
  privacy: {
    path: "/ochrana-soukromi",
    title: "Zásady zpracování osobních údajů",
    summary:
      "Schválené zásady zpracování osobních údajů zatím nejsou k dispozici.",
  },
  prohibitedContent: {
    path: "/zakazany-obsah",
    title: "Pravidla zakázaného obsahu a manuální kontroly",
    summary:
      "Schválená pravidla zakázaného obsahu a manuální kontroly zatím nejsou k dispozici.",
  },
  retention: {
    path: "/uchovani-dat",
    title: "Pravidla uchování dat a opuštěných položek",
    summary:
      "Schválená pravidla uchování dat a opuštěných položek zatím nejsou k dispozici.",
  },
  photoConsent: {
    path: "/fotografie-a-duvernost",
    title: "Souhlas s fotografováním a důvěrnost zakázky",
    summary:
      "Schválená pravidla fotografování a důvěrnosti zatím nejsou k dispozici.",
  },
} as const;

function draftDocument(key: LegalDocumentKey): DraftLegalDocument {
  const draft = legalDrafts[key];
  return {
    ...documentMetadata[key],
    id: draft.sourceDocumentId,
    status: "draft",
    effectiveAt: null,
    approvalEvidence: null,
    sections: draft.sections,
  };
}

// #38 has not supplied counsel-approved IDs, dates, source evidence, or text.
// Keep every production manifest entry explicitly non-effective until it does.
export const legalDocuments: Readonly<Record<LegalDocumentKey, LegalDocument>> =
  {
    terms: draftDocument("terms"),
    claims: draftDocument("claims"),
    privacy: draftDocument("privacy"),
    prohibitedContent: draftDocument("prohibitedContent"),
    retention: draftDocument("retention"),
    photoConsent: draftDocument("photoConsent"),
  };

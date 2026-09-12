export type LegalDocumentKey =
  | "terms"
  | "claims"
  | "privacy"
  | "prohibitedContent"
  | "retention"
  | "photoConsent";

export type CommercialContentStatus = "pending-approval" | "approved";

export const commercialContentApproval = {
  status: "pending-approval" as CommercialContentStatus,
} as const;

export type LegalDocumentApprovalBase = Readonly<{
  id: string;
  path: string;
  title: string;
  summary: string;
}>;

export type DraftLegalDocumentApproval = LegalDocumentApprovalBase &
  Readonly<{
    status: "draft";
    effectiveAt: null;
    approvalEvidence: null;
  }>;

export type ApprovedLegalDocumentApproval = LegalDocumentApprovalBase &
  Readonly<{
    status: "approved";
    effectiveAt: string;
    approvalEvidence: string;
  }>;

export type LegalDocumentApproval =
  DraftLegalDocumentApproval | ApprovedLegalDocumentApproval;

const NON_PRODUCTION_REVISION = /(?:^|[-_.\s])(draft|pending)(?:$|[-_.\s])/i;

export function approvedLegalDocumentApproval(
  input: LegalDocumentApprovalBase &
    Readonly<{ effectiveAt: string; approvalEvidence: string }>,
): ApprovedLegalDocumentApproval {
  if (
    !input.id.trim() ||
    NON_PRODUCTION_REVISION.test(input.id) ||
    !input.effectiveAt.trim() ||
    !Number.isFinite(Date.parse(input.effectiveAt)) ||
    !input.approvalEvidence.trim()
  ) {
    throw new TypeError(
      "Approved legal documents require an ID, effective date, and approval evidence",
    );
  }
  return { ...input, status: "approved" };
}

export function isEffectiveApprovedLegalDocument(
  document: LegalDocumentApproval,
  now = Date.now(),
): document is ApprovedLegalDocumentApproval {
  return (
    document.status === "approved" && Date.parse(document.effectiveAt) <= now
  );
}

const documentMetadata = {
  terms: {
    id: "terms-pending",
    path: "/vop",
    title: "Všeobecné obchodní podmínky",
    summary: "Schválené všeobecné obchodní podmínky zatím nejsou k dispozici.",
  },
  claims: {
    id: "claims-pending",
    path: "/reklamace",
    title: "Reklamační řád",
    summary: "Schválený reklamační řád zatím není k dispozici.",
  },
  privacy: {
    id: "privacy-pending",
    path: "/ochrana-soukromi",
    title: "Zásady zpracování osobních údajů",
    summary:
      "Schválené zásady zpracování osobních údajů zatím nejsou k dispozici.",
  },
  prohibitedContent: {
    id: "prohibited-content-pending",
    path: "/zakazany-obsah",
    title: "Pravidla zakázaného obsahu a manuální kontroly",
    summary:
      "Schválená pravidla zakázaného obsahu a manuální kontroly zatím nejsou k dispozici.",
  },
  retention: {
    id: "retention-pending",
    path: "/uchovani-dat",
    title: "Pravidla uchování dat a opuštěných položek",
    summary:
      "Schválená pravidla uchování dat a opuštěných položek zatím nejsou k dispozici.",
  },
  photoConsent: {
    id: "photo-consent-pending",
    path: "/fotografie-a-duvernost",
    title: "Souhlas s fotografováním a důvěrnost zakázky",
    summary:
      "Schválená pravidla fotografování a důvěrnosti zatím nejsou k dispozici.",
  },
} as const;

function draftLegalDocumentApproval(
  key: LegalDocumentKey,
): DraftLegalDocumentApproval {
  return {
    ...documentMetadata[key],
    status: "draft",
    effectiveAt: null,
    approvalEvidence: null,
  };
}

// #38 has not supplied counsel-approved IDs, dates, source evidence, or text.
// Keep every production manifest entry explicitly non-effective until it does.
export const legalDocumentApprovals: Readonly<
  Record<LegalDocumentKey, LegalDocumentApproval>
> = {
  terms: draftLegalDocumentApproval("terms"),
  claims: draftLegalDocumentApproval("claims"),
  privacy: draftLegalDocumentApproval("privacy"),
  prohibitedContent: draftLegalDocumentApproval("prohibitedContent"),
  retention: draftLegalDocumentApproval("retention"),
  photoConsent: draftLegalDocumentApproval("photoConsent"),
};

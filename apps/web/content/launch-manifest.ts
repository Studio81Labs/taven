import { legalDrafts, type LegalDraftSection } from "./legal-drafts";
import {
  approvedLegalDocumentApproval,
  legalDocumentApprovals,
  type ApprovedLegalDocumentApproval,
  type DraftLegalDocumentApproval,
  type LegalDocumentApprovalBase,
  type LegalDocumentKey,
} from "./launch-approvals";

type LegalDocumentSections = Readonly<{
  sections: readonly LegalDraftSection[];
}>;

type LegalDocumentBase = LegalDocumentApprovalBase & LegalDocumentSections;

export type DraftLegalDocument = DraftLegalDocumentApproval &
  LegalDocumentSections;
export type ApprovedLegalDocument = ApprovedLegalDocumentApproval &
  LegalDocumentSections;
export type LegalDocument = DraftLegalDocument | ApprovedLegalDocument;
export type { LegalDocumentKey } from "./launch-approvals";

export function approvedLegalDocument(
  input: LegalDocumentBase &
    Readonly<{ effectiveAt: string; approvalEvidence: string }>,
): ApprovedLegalDocument {
  return {
    ...approvedLegalDocumentApproval(input),
    sections: input.sections,
  };
}

function document(key: LegalDocumentKey): LegalDocument {
  return {
    ...legalDocumentApprovals[key],
    sections: legalDrafts[key].sections,
  };
}

// #38 has not supplied counsel-approved IDs, dates, source evidence, or text.
// Keep every production manifest entry explicitly non-effective until it does.
export const legalDocuments: Readonly<Record<LegalDocumentKey, LegalDocument>> =
  {
    terms: document("terms"),
    claims: document("claims"),
    privacy: document("privacy"),
    prohibitedContent: document("prohibitedContent"),
    retention: document("retention"),
    photoConsent: document("photoConsent"),
  };

export function isApprovedLegalDocument(
  document: LegalDocument,
): document is ApprovedLegalDocument {
  return document.status === "approved";
}

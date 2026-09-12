import {
  isEffectiveApprovedLegalDocument,
  type LegalDocumentApprovalState,
  type LegalDocumentKey,
} from "../content/launch-manifest";

type AutomaticQuoteLegalDocuments = Pick<
  Readonly<Record<LegalDocumentKey, LegalDocumentApprovalState>>,
  "terms" | "claims" | "privacy" | "prohibitedContent" | "retention"
>;

export function hasEffectiveAutomaticQuoteDocuments(
  documents: AutomaticQuoteLegalDocuments,
): boolean {
  return Object.values(documents).every((document) =>
    isEffectiveApprovedLegalDocument(document),
  );
}

export function isAutomaticQuoteEnabled(input: {
  runtimeEnabled: unknown;
  hasApprovedAcquisitionDocuments: boolean;
  hasApprovedCommercialContent: boolean;
}): boolean {
  return (
    (input.runtimeEnabled === true || input.runtimeEnabled === "true") &&
    input.hasApprovedAcquisitionDocuments &&
    input.hasApprovedCommercialContent
  );
}

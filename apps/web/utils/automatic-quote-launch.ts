import type {
  LegalDocument,
  LegalDocumentKey,
} from "../content/launch-manifest";
import {
  hasServerVerifiedLegalDocuments,
  type LegalAvailability,
} from "./legal-availability";

type AutomaticQuoteLegalDocuments = Pick<
  Readonly<Record<LegalDocumentKey, LegalDocument>>,
  "terms" | "claims" | "privacy" | "prohibitedContent" | "retention"
>;

export function hasEffectiveAutomaticQuoteDocuments(
  documents: AutomaticQuoteLegalDocuments,
  availability: LegalAvailability | null | undefined,
): boolean {
  return hasServerVerifiedLegalDocuments(
    documents as Readonly<Record<LegalDocumentKey, LegalDocument>>,
    ["terms", "claims", "privacy", "prohibitedContent", "retention"],
    availability,
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

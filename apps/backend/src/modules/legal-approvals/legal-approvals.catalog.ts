import { ServiceUnavailableException } from "@nestjs/common";

/** The stable public availability shape is intentionally independent of DB IDs. */
export const LEGAL_DOCUMENT_KEYS = [
  "terms",
  "claims",
  "privacy",
  "prohibitedContent",
  "retention",
  "photoConsent",
] as const;

export type LegalDocumentKey = (typeof LEGAL_DOCUMENT_KEYS)[number];
export type LegalApprovalStatus = "draft" | "approved";

export type EvaluatedLegalDocument = Readonly<{
  revision: string;
  revisionId: string | null;
  status: LegalApprovalStatus;
  effectiveAt: string | null;
  contentHash: string | null;
  effective: boolean;
}>;

export type EvaluatedLegalApprovals = Readonly<{
  schemaVersion: 1;
  policyRevision: string;
  evaluatedAt: string;
  documents: Readonly<Record<LegalDocumentKey, EvaluatedLegalDocument>>;
}>;

export function assertEffectiveLegalDocuments(
  evaluated: EvaluatedLegalApprovals,
  keys: readonly LegalDocumentKey[],
): void {
  if (!keys.every((key) => evaluated.documents[key].effective)) {
    throw legalApprovalRequired(
      "Legal approval metadata is unavailable or not yet effective",
    );
  }
}

export function legalApprovalRequired(
  message: string,
): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: "LAUNCH_APPROVAL_REQUIRED",
    message,
  });
}

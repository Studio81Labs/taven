import { ServiceUnavailableException } from "@nestjs/common";

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

export type LegalApprovalRecord = Readonly<{
  revision: string;
  status: LegalApprovalStatus;
  effectiveAt: string | null;
  approvalEvidence: string | null;
}>;

export type LegalApprovalCatalog = Readonly<{
  schemaVersion: 1;
  policyRevision: string;
  documents: Readonly<Record<LegalDocumentKey, LegalApprovalRecord>>;
}>;

// #38 has not supplied immutable approved revisions, UTC instants, or evidence.
// PR5 replaces these matching draft entries together with the web text.
export const legalApprovalCatalog: LegalApprovalCatalog = {
  schemaVersion: 1,
  policyRevision: "legal-policy-v1-draft",
  documents: {
    terms: draft("terms-pending"),
    claims: draft("claims-pending"),
    privacy: draft("privacy-pending"),
    prohibitedContent: draft("prohibited-content-pending"),
    retention: draft("retention-pending"),
    photoConsent: draft("photo-consent-pending"),
  },
};

/** Isolated test-only fixture; production always uses the draft catalog above. */
export function activeLegalApprovalCatalog(
  env: NodeJS.ProcessEnv = process.env,
): LegalApprovalCatalog {
  if (env.NODE_ENV !== "test") return legalApprovalCatalog;
  const revisions: Record<LegalDocumentKey, string> = {
    terms: env.TAVEN_TERMS_REVISION ?? "terms-test-v1",
    claims: env.TAVEN_CLAIM_POLICY_REVISION ?? "claims-test-v1",
    privacy: "privacy-test-v1",
    prohibitedContent: "prohibited-content-test-v1",
    retention: "retention-test-v1",
    photoConsent: env.TAVEN_PHOTO_CONSENT_REVISION ?? "photo-consent-test-v1",
  };
  return {
    schemaVersion: 1,
    policyRevision: "legal-policy-test-fixture-v1",
    documents: Object.fromEntries(
      LEGAL_DOCUMENT_KEYS.map((key) => [
        key,
        {
          revision: revisions[key],
          status: "approved",
          effectiveAt: "2000-01-01T00:00:00.000Z",
          approvalEvidence: "test fixture",
        },
      ]),
    ) as Record<LegalDocumentKey, LegalApprovalRecord>,
  };
}

function draft(revision: string): LegalApprovalRecord {
  return {
    revision,
    status: "draft",
    effectiveAt: null,
    approvalEvidence: null,
  };
}

export type EvaluatedLegalDocument = Readonly<{
  revision: string;
  status: LegalApprovalStatus;
  effectiveAt: string | null;
  effective: boolean;
}>;

export type EvaluatedLegalApprovals = Readonly<{
  schemaVersion: 1;
  policyRevision: string;
  evaluatedAt: string;
  documents: Readonly<Record<LegalDocumentKey, EvaluatedLegalDocument>>;
}>;

export function evaluateLegalApprovals(
  observedAt: Date,
  catalog: LegalApprovalCatalog = legalApprovalCatalog,
): EvaluatedLegalApprovals {
  assertCatalog(catalog);
  return {
    schemaVersion: catalog.schemaVersion,
    policyRevision: catalog.policyRevision,
    evaluatedAt: observedAt.toISOString(),
    documents: Object.fromEntries(
      LEGAL_DOCUMENT_KEYS.map((key) => {
        const document = catalog.documents[key];
        const effective =
          document.status === "approved" &&
          document.effectiveAt !== null &&
          Date.parse(document.effectiveAt) <= observedAt.getTime();
        return [
          key,
          {
            revision: document.revision,
            status: document.status,
            effectiveAt: document.effectiveAt,
            effective,
          },
        ];
      }),
    ) as Record<LegalDocumentKey, EvaluatedLegalDocument>,
  };
}

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

function assertCatalog(catalog: LegalApprovalCatalog): void {
  if (catalog.schemaVersion !== 1 || !catalog.policyRevision.trim()) {
    throw new Error("Legal approval catalog is invalid");
  }
  for (const key of LEGAL_DOCUMENT_KEYS) {
    const document = catalog.documents[key];
    if (!document || !document.revision.trim())
      throw new Error("Legal approval catalog is invalid");
    if (document.status === "draft") {
      if (document.effectiveAt !== null || document.approvalEvidence !== null)
        throw new Error("Legal draft is invalid");
      continue;
    }
    if (
      document.status !== "approved" ||
      !document.effectiveAt ||
      new Date(document.effectiveAt).toISOString() !== document.effectiveAt ||
      /(?:^|[-_.\s])(draft|pending)(?:$|[-_.\s])/i.test(document.revision) ||
      !document.approvalEvidence?.trim()
    )
      throw new Error("Legal approval catalog is invalid");
  }
}

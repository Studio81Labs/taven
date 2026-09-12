import type {
  LegalDocument,
  LegalDocumentKey,
} from "../content/launch-manifest";

export type LegalAvailability = Readonly<{
  schemaVersion: 1;
  policyRevision: string;
  evaluatedAt: string;
  documents: Readonly<
    Record<
      LegalDocumentKey,
      Readonly<{
        revision: string;
        status: "draft" | "approved";
        effectiveAt: string | null;
        effective: boolean;
      }>
    >
  >;
}>;

export function isServerVerifiedLegalDocument(
  key: LegalDocumentKey,
  local: LegalDocument,
  availability: LegalAvailability | null | undefined,
): boolean {
  if (!availability || local.status !== "approved") return false;
  const record = availability.documents[key];
  return Boolean(
    record &&
    record.status === "approved" &&
    record.effective &&
    record.effectiveAt === local.effectiveAt,
  );
}

export function hasServerVerifiedLegalDocuments(
  documents: Readonly<Record<LegalDocumentKey, LegalDocument>>,
  keys: readonly LegalDocumentKey[],
  availability: LegalAvailability | null | undefined,
): boolean {
  return keys.every((key) =>
    isServerVerifiedLegalDocument(key, documents[key], availability),
  );
}

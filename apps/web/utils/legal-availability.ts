import type {
  LegalDocument,
  LegalDocumentKey,
} from "../content/launch-manifest";

const LEGAL_DOCUMENT_KEYS = [
  "terms",
  "claims",
  "privacy",
  "prohibitedContent",
  "retention",
  "photoConsent",
] as const satisfies readonly LegalDocumentKey[];

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

export function isLegalAvailability(
  value: unknown,
): value is LegalAvailability {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.policyRevision !== "string") return false;
  const documents = value.documents;
  if (typeof value.evaluatedAt !== "string" || !isRecord(documents))
    return false;
  return LEGAL_DOCUMENT_KEYS.every((key) => {
    const document = documents[key];
    return (
      isRecord(document) &&
      typeof document.revision === "string" &&
      (document.status === "draft" || document.status === "approved") &&
      (typeof document.effectiveAt === "string" ||
        document.effectiveAt === null) &&
      typeof document.effective === "boolean"
    );
  });
}

export function isServerVerifiedLegalDocument(
  key: LegalDocumentKey,
  local: LegalDocument,
  availability: LegalAvailability | null | undefined,
): boolean {
  if (!availability || local.status !== "approved") return false;
  const record = availability.documents[key];
  return Boolean(
    record &&
    record.revision === local.id &&
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

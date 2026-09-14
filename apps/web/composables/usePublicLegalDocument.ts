import type { components } from "@taven/openapi-client";
import { legalDocuments } from "../content/public-site";
import type { LegalDocumentKey } from "../content/launch-manifest";
import { useLegalAvailability } from "./useLegalAvailability";

type PublicRevision = components["schemas"]["PublicLegalRevisionDto"];

export type PublicLegalDocument = Readonly<{
  id: string;
  path: string;
  title: string;
  summary: string;
  sections: readonly {
    title: string;
    paragraphs?: readonly string[];
    items?: readonly string[];
    note?: string;
  }[];
  effectiveAt: string | null;
}>;

/**
 * The bundled draft is presentation-only fallback. Acceptance never trusts it:
 * an effective document must be fetched by the revision/hash advertised by DB.
 */
export function usePublicLegalDocument(key: LegalDocumentKey) {
  const { $api } = useNuxtApp();
  const { availability, refresh: refreshAvailability } = useLegalAvailability();
  const fallback = legalDocuments[key];
  const document = useState<PublicLegalDocument>(
    `legal-document:${key}`,
    () => ({
      id: fallback.id,
      path: fallback.path,
      title: fallback.title,
      summary: fallback.summary,
      sections: fallback.sections,
      effectiveAt: null,
    }),
  );
  const effective = computed(
    () =>
      availability.value?.documents[key].effective === true &&
      document.value.effectiveAt ===
        availability.value.documents[key].effectiveAt &&
      document.value.id === availability.value.documents[key].revision,
  );

  async function refresh(): Promise<void> {
    const selected = await refreshAvailability();
    const record = selected?.documents[key];
    if (!record?.effective || !record.contentHash || !record.effectiveAt) {
      document.value = {
        id: fallback.id,
        path: fallback.path,
        title: fallback.title,
        summary: fallback.summary,
        sections: fallback.sections,
        effectiveAt: null,
      };
      return;
    }
    try {
      const response = await $api.GET(
        "/legal-documents/{key}/revisions/{revisionCode}",
        { params: { path: { key, revisionCode: record.revision } } },
      );
      const revision = response.data as PublicRevision | undefined;
      if (
        !revision ||
        revision.key !== key ||
        revision.revisionCode !== record.revision ||
        revision.contentHash !== record.contentHash ||
        revision.effectiveAt !== record.effectiveAt
      ) {
        throw new Error("stale legal document response");
      }
      document.value = {
        id: revision.revisionCode,
        path: fallback.path,
        title: revision.title,
        summary: revision.summary,
        sections: revision.sections,
        effectiveAt: revision.effectiveAt,
      };
    } catch {
      document.value = {
        id: fallback.id,
        path: fallback.path,
        title: fallback.title,
        summary: fallback.summary,
        sections: fallback.sections,
        effectiveAt: null,
      };
    }
  }

  return { document: readonly(document), effective, refresh };
}

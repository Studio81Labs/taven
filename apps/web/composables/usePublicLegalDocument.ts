import type { components } from "@taven/openapi-client";
import { toValue, type MaybeRefOrGetter } from "vue";
import { legalDocuments } from "../content/public-site";
import type { LegalDocumentKey } from "../content/launch-manifest";
import type { LegalAvailability } from "../utils/legal-availability";
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
  contentHash: string | null;
}>;

/**
 * The bundled draft is presentation-only fallback. Acceptance never trusts it:
 * an effective document must be fetched by the revision/hash advertised by DB.
 */
export function usePublicLegalDocument(
  key: LegalDocumentKey,
  pinnedRevision?: MaybeRefOrGetter<string | null>,
  pinnedContentHash?: MaybeRefOrGetter<string | null>,
) {
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
      contentHash: null,
    }),
  );
  const historical = useState<boolean>(
    `legal-document-historical:${key}`,
    () => false,
  );
  const effective = computed(() => {
    return (
      availability.value?.documents[key].effective === true &&
      document.value.effectiveAt ===
        availability.value.documents[key].effectiveAt &&
      document.value.id === availability.value.documents[key].revision &&
      document.value.contentHash ===
        availability.value.documents[key].contentHash
    );
  });

  async function refresh(
    selectedAvailability?: LegalAvailability | null,
  ): Promise<void> {
    const selected = selectedAvailability ?? (await refreshAvailability());
    const record = selected?.documents[key];
    const revisionCode = pinnedRevision ? toValue(pinnedRevision) : null;
    const contentHash = pinnedContentHash ? toValue(pinnedContentHash) : null;
    if (
      !revisionCode &&
      (!record?.effective || !record.contentHash || !record.effectiveAt)
    ) {
      document.value = {
        id: fallback.id,
        path: fallback.path,
        title: fallback.title,
        summary: fallback.summary,
        sections: fallback.sections,
        effectiveAt: null,
        contentHash: null,
      };
      historical.value = false;
      return;
    }
    try {
      const response = await Promise.race([
        $api.GET("/legal-documents/{key}/revisions/{revisionCode}", {
          params: {
            path: { key, revisionCode: revisionCode ?? record!.revision },
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 1_000),
        ),
      ]);
      const revision = response.data as PublicRevision | undefined;
      if (
        !revision ||
        revision.key !== key ||
        revision.revisionCode !== (revisionCode ?? record!.revision) ||
        revision.contentHash !== (contentHash ?? record!.contentHash) ||
        (!revisionCode && revision.effectiveAt !== record!.effectiveAt)
      ) {
        throw new Error("stale legal document response");
      }
      const latest = await refreshAvailability();
      const latestRecord = latest?.documents[key];
      if (!revisionCode) {
        if (
          !latestRecord?.effective ||
          latestRecord.revision !== revision.revisionCode ||
          latestRecord.contentHash !== revision.contentHash ||
          latestRecord.effectiveAt !== revision.effectiveAt
        ) {
          throw new Error("legal document availability changed during fetch");
        }
      }
      document.value = {
        id: revision.revisionCode,
        path: fallback.path,
        title: revision.title,
        summary: revision.summary,
        sections: revision.sections,
        effectiveAt: revision.effectiveAt,
        contentHash: revision.contentHash,
      };
      historical.value =
        Boolean(revisionCode) &&
        (!latestRecord ||
          !latestRecord.effective ||
          latestRecord.revision !== revision.revisionCode ||
          latestRecord.contentHash !== revision.contentHash);
    } catch {
      document.value = {
        id: fallback.id,
        path: fallback.path,
        title: fallback.title,
        summary: fallback.summary,
        sections: fallback.sections,
        effectiveAt: null,
        contentHash: null,
      };
      historical.value = false;
    }
  }

  return { document: readonly(document), effective, historical, refresh };
}

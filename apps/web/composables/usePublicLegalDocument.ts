import type { components } from "@taven/openapi-client";
import { toValue, type MaybeRefOrGetter } from "vue";
import { legalDocuments } from "../content/public-site";
import type { LegalDocumentKey } from "../content/launch-manifest";
import type { LegalAvailability } from "../utils/legal-availability";
import { useLegalAvailability } from "./useLegalAvailability";

type PublicRevision = components["schemas"]["PublicLegalRevisionDto"];
type LegalDocumentCache = Record<string, PublicLegalDocument>;
type HistoricalCache = Record<string, boolean>;

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
  const identity = (revision: string | null, contentHash: string | null) =>
    `${revision ?? "current"}:${contentHash ?? ""}`;
  const currentIdentity = computed(() =>
    identity(
      pinnedRevision ? toValue(pinnedRevision) : null,
      pinnedContentHash ? toValue(pinnedContentHash) : null,
    ),
  );
  const initialIdentity = currentIdentity.value;
  const fallbackDocument = (): PublicLegalDocument => ({
    id: fallback.id,
    path: fallback.path,
    title: fallback.title,
    summary: fallback.summary,
    sections: fallback.sections,
    effectiveAt: null,
    contentHash: null,
  });
  // Keep each pinned revision/hash in its own cache entry. The active entry is
  // selected reactively so reused page components cannot write revision B into
  // revision A's state when navigation changes the pinned identity.
  const documentCache = useState<LegalDocumentCache>(
    `legal-document-cache:${key}`,
    () => ({ [initialIdentity]: fallbackDocument() }),
  );
  const historicalCache = useState<HistoricalCache>(
    `legal-document-historical-cache:${key}`,
    () => ({ [initialIdentity]: false }),
  );
  const document = computed<PublicLegalDocument>({
    get: () => documentCache.value[currentIdentity.value] ?? fallbackDocument(),
    set: (value) => {
      documentCache.value = {
        ...documentCache.value,
        [currentIdentity.value]: value,
      };
    },
  });
  const historical = computed<boolean>({
    get: () => historicalCache.value[currentIdentity.value] ?? false,
    set: (value) => {
      historicalCache.value = {
        ...historicalCache.value,
        [currentIdentity.value]: value,
      };
    },
  });
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
  let refreshGeneration = 0;

  async function refresh(
    selectedAvailability?: LegalAvailability | null,
  ): Promise<void> {
    const generation = ++refreshGeneration;
    const revisionCode = pinnedRevision ? toValue(pinnedRevision) : null;
    const contentHash = pinnedContentHash ? toValue(pinnedContentHash) : null;
    const selected = selectedAvailability ?? (await refreshAvailability());
    const record = selected?.documents[key];
    const isCurrent = () =>
      generation === refreshGeneration &&
      revisionCode === (pinnedRevision ? toValue(pinnedRevision) : null) &&
      contentHash === (pinnedContentHash ? toValue(pinnedContentHash) : null);
    if (
      !revisionCode &&
      (!record?.effective || !record.contentHash || !record.effectiveAt)
    ) {
      if (!isCurrent()) return;
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
      if (!isCurrent()) return;
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
      if (!isCurrent()) return;
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

  if (pinnedRevision || pinnedContentHash) {
    watch(
      [
        () => (pinnedRevision ? toValue(pinnedRevision) : null),
        () => (pinnedContentHash ? toValue(pinnedContentHash) : null),
      ],
      ([revision, contentHash], previous) => {
        if (revision === previous[0] && contentHash === previous[1]) return;
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
        void refresh();
      },
    );
  }

  return { document: readonly(document), effective, historical, refresh };
}

import type { components } from "@taven/openapi-client";
import {
  MAX_LOCAL_PREVIEW_BYTES,
  ModelFileValidationError,
  sha256Hex,
  validateModelFile,
  type ValidatedModelFile,
} from "../utils/model-file";
import {
  ModelGeometryError,
  parseModelGeometry,
  type ModelGeometry,
} from "../utils/model-geometry";
import {
  clearQuoteSession,
  loadQuoteSession,
  saveQuoteSession,
} from "../utils/quote-session-storage";
import { UploadFailure, uploadFile } from "../utils/upload-file";

type QuoteSession = components["schemas"]["AutomaticQuoteSessionDto"];

const backgroundQuotePhases: ReadonlySet<QuoteSession["phase"]> = new Set([
  "INSPECTION_PENDING",
  "REFERENCE_SLICES_PENDING",
  "ELIGIBILITY_PENDING",
]);

export function isBackgroundQuotePhase(phase: QuoteSession["phase"]): boolean {
  return backgroundQuotePhases.has(phase);
}

export type UploadWorkflowPhase =
  | "cancelled"
  | "complete"
  | "error"
  | "expired"
  | "handoff"
  | "idle"
  | "inspecting"
  | "preparing"
  | "ready"
  | "uploading";

function idempotencyKey(scope: string): string {
  return `${scope}-${crypto.randomUUID()}`;
}

function requestMessage(
  status: number,
  stage: "attach" | "confirm" | "intent" | "session",
): string {
  if (status === 410) {
    return "Platnost nahrání vypršela. Spusťte odeslání souboru znovu.";
  }
  if (status === 429) {
    return "Limit nových nahrání je teď vyčerpaný. Počkejte chvíli a zkuste to znovu.";
  }
  if (status === 409 && stage === "confirm") {
    return "Kontrolní otisk nahraného souboru nesouhlasí. Odešlete soubor znovu.";
  }
  if (status === 401) {
    return "Oprávnění k tomuto nahrání už není platné. Začněte prosím znovu.";
  }
  return "Požadavek se nepodařilo dokončit. Zkontrolujte připojení a zkuste to znovu.";
}

export function useModelUploadQuote() {
  const { $api } = useNuxtApp();
  const phase = ref<UploadWorkflowPhase>("idle");
  const selectedFile = shallowRef<File>();
  const metadata = ref<ValidatedModelFile>();
  const sha256 = ref<string>();
  const geometry = shallowRef<ModelGeometry>();
  const previewMessage = ref<string>();
  const errorMessage = ref<string>();
  const handoffMessage = ref<string>();
  const uploadProgress = ref(0);
  const quote = shallowRef<QuoteSession>();
  const sessionToken = ref<string>();
  const restoredFilename = ref<string>();
  let selectionRevision = 0;
  let uploadController: AbortController | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const filename = computed(
    () => selectedFile.value?.name ?? restoredFilename.value,
  );
  const canUpload = computed(
    () =>
      phase.value === "ready" &&
      Boolean(selectedFile.value && metadata.value && sha256.value),
  );
  function stopPolling(): void {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function resetState(clearStoredSession = true): void {
    selectionRevision += 1;
    uploadController?.abort();
    uploadController = undefined;
    stopPolling();
    phase.value = "idle";
    selectedFile.value = undefined;
    metadata.value = undefined;
    sha256.value = undefined;
    geometry.value = undefined;
    previewMessage.value = undefined;
    errorMessage.value = undefined;
    handoffMessage.value = undefined;
    uploadProgress.value = 0;
    quote.value = undefined;
    sessionToken.value = undefined;
    restoredFilename.value = undefined;
    if (clearStoredSession && import.meta.client) {
      clearQuoteSession(sessionStorage);
    }
  }

  async function selectFile(file: File): Promise<void> {
    resetState();
    const revision = selectionRevision;
    phase.value = "preparing";

    try {
      const valid = validateModelFile(file);
      selectedFile.value = file;
      metadata.value = valid;
      const buffer = await file.arrayBuffer();
      if (revision !== selectionRevision) return;

      const hashPromise = sha256Hex(buffer);
      if (buffer.byteLength <= MAX_LOCAL_PREVIEW_BYTES) {
        try {
          geometry.value = await parseModelGeometry(valid.format, buffer);
        } catch (error) {
          if (
            error instanceof ModelGeometryError &&
            error.code === "PAINTED_OR_MULTIMATERIAL_3MF"
          ) {
            handoffMessage.value = error.message;
            phase.value = "handoff";
            return;
          }
          previewMessage.value =
            error instanceof Error
              ? error.message
              : "Náhled se nepodařilo připravit. Soubor přesto zkontrolujeme po nahrání.";
        }
      } else {
        previewMessage.value =
          "Soubor je pro místní náhled příliš velký. Bezpečně ho zkontrolujeme po nahrání.";
      }
      sha256.value = await hashPromise;
      if (revision !== selectionRevision) return;
      phase.value = "ready";
    } catch (error) {
      if (revision !== selectionRevision) return;
      if (
        error instanceof ModelFileValidationError &&
        error.code === "INDIVIDUAL_QUOTE_REQUIRED"
      ) {
        handoffMessage.value = error.message;
        phase.value = "handoff";
        return;
      }
      errorMessage.value =
        error instanceof Error ? error.message : "Soubor se nepodařilo načíst.";
      phase.value = "error";
    }
  }

  function applyQuote(nextQuote: QuoteSession): boolean {
    quote.value = nextQuote;
    if (nextQuote.phase === "EXPIRED") {
      phase.value = "expired";
      stopPolling();
      if (import.meta.client) clearQuoteSession(sessionStorage);
      return true;
    }
    if (nextQuote.phase === "HANDOFF_REQUIRED") {
      phase.value = "handoff";
      const reasons = nextQuote.handoff?.reasons ?? [];
      handoffMessage.value = reasons.includes("UNSUPPORTED_FORMAT")
        ? "Tento formát přímá kalkulace neumí. Exportujte model jako STL nebo nebarvený 3MF."
        : reasons.includes("INSPECTION_FAILED")
          ? "Soubor se po nahrání nepodařilo přečíst. Ověřte ho v modelovacím programu a exportujte jej znovu."
          : "Kontrola našla problém, který nelze bezpečně vyřešit automaticky. Upravte model podle kontroly nebo vyberte jiný soubor.";
      stopPolling();
      return true;
    }
    if (
      isBackgroundQuotePhase(nextQuote.phase) ||
      nextQuote.modelFiles.some((model) => model.inspectionStatus === "PENDING")
    ) {
      phase.value = "inspecting";
      return false;
    }
    phase.value = "complete";
    stopPolling();
    return true;
  }

  async function refreshQuote(): Promise<void> {
    const id = quote.value?.sessionId;
    const token = sessionToken.value;
    if (!id || !token) return;
    try {
      const result = await $api.GET("/automatic-quote-sessions/{sessionId}", {
        params: { path: { sessionId: id } },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!result.response.ok || !result.data) {
        if (result.response.status === 401) {
          errorMessage.value = requestMessage(401, "session");
          phase.value = "error";
          stopPolling();
          if (import.meta.client) clearQuoteSession(sessionStorage);
        } else {
          pollTimer = setTimeout(() => void refreshQuote(), 3_000);
        }
        return;
      }
      if (!applyQuote(result.data)) {
        pollTimer = setTimeout(() => void refreshQuote(), 1_500);
      }
    } catch {
      pollTimer = setTimeout(() => void refreshQuote(), 3_000);
    }
  }

  async function startUpload(): Promise<void> {
    const file = selectedFile.value;
    const valid = metadata.value;
    const hash = sha256.value;
    if (!file || !valid || !hash || !canUpload.value) return;

    errorMessage.value = undefined;
    phase.value = "uploading";
    uploadProgress.value = 0;
    uploadController = new AbortController();
    const signal = uploadController.signal;

    try {
      const intent = await $api.POST("/storage/uploads/model-files", {
        body: {
          contentType: valid.contentType,
          format: valid.format,
          originalFilename: valid.originalFilename,
          sha256: hash,
          sizeBytes: valid.sizeBytes,
        },
        signal,
      });
      if (!intent.response.ok || !intent.data) {
        throw new Error(requestMessage(intent.response.status, "intent"));
      }

      await uploadFile({
        file,
        onProgress: (progress) => {
          uploadProgress.value = progress;
        },
        requiredHeaders: intent.data.requiredHeaders,
        signal,
        uploadUrl: intent.data.uploadUrl,
      });
      uploadProgress.value = 100;

      const confirmation = await $api.POST(
        "/storage/uploads/{uploadId}/confirm",
        {
          params: { path: { uploadId: intent.data.uploadId } },
          headers: { Authorization: `Bearer ${intent.data.accessToken}` },
          signal,
        },
      );
      if (!confirmation.response.ok || !confirmation.data) {
        throw new Error(
          requestMessage(confirmation.response.status, "confirm"),
        );
      }

      const created = await $api.POST("/automatic-quote-sessions", {
        body: { attribution: { channel: "web-upload" } },
        params: {
          header: { "Idempotency-Key": idempotencyKey("create-session") },
        },
        signal,
      });
      if (!created.response.ok || !created.data) {
        throw new Error(requestMessage(created.response.status, "session"));
      }

      const attached = await $api.POST(
        "/automatic-quote-sessions/{sessionId}/model-files",
        {
          body: {
            modelFileId: confirmation.data.assetId,
            uploadToken: intent.data.accessToken,
          },
          headers: {
            Authorization: `Bearer ${created.data.sessionToken}`,
          },
          params: {
            header: { "Idempotency-Key": idempotencyKey("attach-model") },
            path: { sessionId: created.data.sessionId },
          },
          signal,
        },
      );
      if (!attached.response.ok || !attached.data) {
        throw new Error(requestMessage(attached.response.status, "attach"));
      }

      sessionToken.value = created.data.sessionToken;
      restoredFilename.value = file.name;
      selectedFile.value = undefined;
      sha256.value = undefined;
      if (import.meta.client) {
        saveQuoteSession(sessionStorage, {
          expiresAt: attached.data.expiresAt,
          filename: file.name,
          publicReference: attached.data.publicReference,
          sessionId: attached.data.sessionId,
          sessionToken: created.data.sessionToken,
        });
      }
      if (!applyQuote(attached.data)) {
        void refreshQuote();
      }
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof UploadFailure && error.code === "ABORTED")
      ) {
        phase.value = "cancelled";
        errorMessage.value =
          error instanceof Error ? error.message : "Nahrání bylo zrušeno.";
      } else {
        errorMessage.value =
          error instanceof Error
            ? error.message
            : "Nahrání se nepodařilo. Zkuste to znovu.";
        phase.value = "error";
      }
    } finally {
      uploadController = undefined;
    }
  }

  function cancelUpload(): void {
    uploadController?.abort();
  }

  function retry(): void {
    if (selectedFile.value && metadata.value && sha256.value) {
      errorMessage.value = undefined;
      phase.value = "ready";
      void startUpload();
    } else {
      resetState();
    }
  }

  async function restoreSession(): Promise<void> {
    if (!import.meta.client) return;
    const stored = loadQuoteSession(sessionStorage);
    if (!stored) return;

    restoredFilename.value = stored.filename;
    sessionToken.value = stored.sessionToken;
    quote.value = {
      bindingQuote: null,
      checkoutReady: false,
      configurationRevision: 0,
      expiresAt: stored.expiresAt,
      express: { eligible: false, reasons: [], requested: false },
      handoff: null,
      items: [],
      modelFiles: [],
      orderId: "",
      phase: "INSPECTION_PENDING",
      publicReference: stored.publicReference,
      roughEstimate: null,
      sessionId: stored.sessionId,
    };
    phase.value = "inspecting";
    await refreshQuote();
  }

  onMounted(() => void restoreSession());
  onBeforeUnmount(() => {
    uploadController?.abort();
    stopPolling();
  });

  return {
    canUpload,
    cancelUpload,
    errorMessage,
    filename,
    geometry,
    handoffMessage,
    metadata,
    phase,
    previewMessage,
    quote,
    resetState,
    retry,
    selectFile,
    startUpload,
    uploadProgress,
  };
}

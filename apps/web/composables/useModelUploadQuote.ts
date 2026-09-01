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
  getSessionStorage,
  loadQuoteSession,
  saveQuoteSession,
} from "../utils/quote-session-storage";
import { UploadFailure, uploadFile } from "../utils/upload-file";

type QuoteSession = components["schemas"]["AutomaticQuoteSessionDto"];
type CreatedQuoteSession =
  components["schemas"]["AutomaticQuoteSessionCreatedDto"];
type ConfirmedUpload = components["schemas"]["ConfirmedUploadResponseDto"];
type UploadIntent = components["schemas"]["UploadIntentResponseDto"];
type ReplaceConfiguration =
  components["schemas"]["ReplaceAutomaticQuoteConfigurationDto"];
type RiskDecision = components["schemas"]["AutomaticQuoteRiskDecisionDto"];
type DeliveryDestination =
  components["schemas"]["SelectAutomaticQuoteDestinationDto"];

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

export function createUploadCommandKeys(
  createKey: (scope: string) => string = idempotencyKey,
) {
  let attachModel: string | undefined;
  let createSession: string | undefined;

  return {
    attachModel: () => (attachModel ??= createKey("attach-model")),
    createSession: () => (createSession ??= createKey("create-session")),
    resetAttachModel: () => {
      attachModel = undefined;
    },
    reset: () => {
      attachModel = undefined;
      createSession = undefined;
    },
  };
}

export function createUploadTransferCheckpoint() {
  let putCompleted = false;

  return {
    markPutCompleted: () => {
      putCompleted = true;
    },
    needsPut: () => !putCompleted,
    reset: () => {
      putCompleted = false;
    },
  };
}

export function createQuoteCommandKeys(
  createKey: (scope: string) => string = idempotencyKey,
) {
  const keys = new Map<string, string>();
  const identity = (scope: string, input: unknown) =>
    `${scope}:${JSON.stringify(input)}`;

  return {
    complete: (scope: string, input: unknown) => {
      keys.delete(identity(scope, input));
    },
    get: (scope: string, input: unknown) => {
      const command = identity(scope, input);
      const existing = keys.get(command);
      if (existing) return existing;
      const created = createKey(scope);
      keys.set(command, created);
      return created;
    },
    reset: () => keys.clear(),
  };
}

export function createLatestResponseGuard() {
  let revision = 0;
  return {
    begin: () => (revision += 1),
    isCurrent: (candidate: number) => candidate === revision,
    reset: () => {
      revision += 1;
    },
  };
}

export function isTerminalUploadConfirmationStatus(status: number): boolean {
  return status === 401 || status === 409 || status === 410;
}

export function isTerminalAttachmentStatus(status: number): boolean {
  return status === 401 || status === 409 || status === 410;
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
  const commandPending = ref(false);
  const commandError = ref<string>();
  const quote = shallowRef<QuoteSession>();
  const sessionToken = ref<string>();
  const restoredFilename = ref<string>();
  let selectionRevision = 0;
  let uploadController: AbortController | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollController: AbortController | undefined;
  let commandController: AbortController | undefined;
  let disposed = false;
  let uploadIntent: UploadIntent | undefined;
  let confirmedUpload: ConfirmedUpload | undefined;
  let createdSession: CreatedQuoteSession | undefined;
  const commandKeys = createUploadCommandKeys();
  const quoteCommandKeys = createQuoteCommandKeys();
  const responseGuard = createLatestResponseGuard();
  const transferCheckpoint = createUploadTransferCheckpoint();

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
    pollController?.abort();
    pollController = undefined;
  }

  function scheduleQuoteRefresh(delay: number): void {
    if (disposed) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      if (!disposed) void refreshQuote();
    }, delay);
  }

  function discardUploadCheckpoint(): void {
    uploadIntent = undefined;
    confirmedUpload = undefined;
    transferCheckpoint.reset();
    commandKeys.resetAttachModel();
    uploadProgress.value = 0;
  }

  function discardAttachmentCheckpoint(): void {
    uploadIntent = undefined;
    confirmedUpload = undefined;
    createdSession = undefined;
    transferCheckpoint.reset();
    commandKeys.reset();
    uploadProgress.value = 0;
  }

  function resetState(clearStoredSession = true): void {
    selectionRevision += 1;
    uploadController?.abort();
    uploadController = undefined;
    commandController?.abort();
    commandController = undefined;
    responseGuard.reset();
    stopPolling();
    phase.value = "idle";
    selectedFile.value = undefined;
    metadata.value = undefined;
    sha256.value = undefined;
    geometry.value = undefined;
    previewMessage.value = undefined;
    errorMessage.value = undefined;
    commandError.value = undefined;
    commandPending.value = false;
    handoffMessage.value = undefined;
    uploadProgress.value = 0;
    quote.value = undefined;
    sessionToken.value = undefined;
    restoredFilename.value = undefined;
    uploadIntent = undefined;
    confirmedUpload = undefined;
    createdSession = undefined;
    transferCheckpoint.reset();
    commandKeys.reset();
    quoteCommandKeys.reset();
    if (clearStoredSession && import.meta.client) {
      const storage = getSessionStorage(window);
      if (storage) clearQuoteSession(storage);
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
      if (import.meta.client) {
        const storage = getSessionStorage(window);
        if (storage) clearQuoteSession(storage);
      }
      return true;
    }
    if (nextQuote.phase === "HANDOFF_REQUIRED") {
      phase.value = "handoff";
      const reasons = nextQuote.handoff?.reasons ?? [];
      handoffMessage.value = reasons.includes("UNSUPPORTED_FORMAT")
        ? "Tento formát přímá kalkulace neumí. Exportujte model jako STL nebo nebarvený 3MF."
        : reasons.includes("INSPECTION_FAILED")
          ? "Soubor se po nahrání nepodařilo přečíst. Ověřte ho v modelovacím programu a exportujte jej znovu."
          : reasons.includes("FIT_SENSITIVE")
            ? "Lícovaný díl vyžaduje zkušební kus nebo individuální nabídku. Předáme bezpečný kontext této kalkulace k ručnímu posouzení."
            : reasons.includes("RISK_DECLINED")
              ? "Riziko jste nepřijali. Přímá kalkulace se zastavila; bezpečný kontext je připravený pro navazující individuální poptávku."
              : reasons.some((reason) =>
                    [
                      "AUTOMATIC_QUANTITY_LIMIT_EXCEEDED",
                      "BUILD_LIMIT_EXCEEDED",
                      "NO_CONFIGURATION_AVAILABLE",
                      "SHIPMENT_INELIGIBLE",
                    ].includes(reason),
                  )
                ? "Aktuální kapacita nebo doprava nestačí pro bezpečnou automatickou cenu. Zakázku je potřeba posoudit individuálně."
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
    if (disposed) return;
    const id = quote.value?.sessionId;
    const token = sessionToken.value;
    if (!id || !token) return;
    const responseRevision = responseGuard.begin();
    const controller = new AbortController();
    pollController = controller;
    try {
      const result = await $api.GET("/automatic-quote-sessions/{sessionId}", {
        params: { path: { sessionId: id } },
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (
        disposed ||
        controller.signal.aborted ||
        !responseGuard.isCurrent(responseRevision)
      )
        return;
      if (!result.response.ok || !result.data) {
        if (result.response.status === 401) {
          errorMessage.value = requestMessage(401, "session");
          phase.value = "error";
          stopPolling();
          if (import.meta.client) {
            const storage = getSessionStorage(window);
            if (storage) clearQuoteSession(storage);
          }
        } else {
          scheduleQuoteRefresh(3_000);
        }
        return;
      }
      if (!applyQuote(result.data)) {
        scheduleQuoteRefresh(1_500);
      }
    } catch {
      if (!disposed && !controller.signal.aborted) {
        scheduleQuoteRefresh(3_000);
      }
    } finally {
      if (pollController === controller) pollController = undefined;
    }
  }

  async function runQuoteCommand(
    scope: string,
    input: unknown,
    operation: (
      signal: AbortSignal,
      key: string,
    ) => Promise<{ data?: QuoteSession; response: Response }>,
  ): Promise<boolean> {
    if (!quote.value?.sessionId || !sessionToken.value || disposed)
      return false;

    stopPolling();
    commandController?.abort();
    const controller = new AbortController();
    commandController = controller;
    const responseRevision = responseGuard.begin();
    const key = quoteCommandKeys.get(scope, input);
    commandPending.value = true;
    commandError.value = undefined;
    try {
      const result = await operation(controller.signal, key);
      if (
        disposed ||
        controller.signal.aborted ||
        !responseGuard.isCurrent(responseRevision)
      )
        return false;
      if (!result.response.ok || !result.data) {
        commandError.value = quoteCommandMessage(result.response.status);
        if (result.response.status === 410) {
          phase.value = "expired";
          if (import.meta.client) {
            const storage = getSessionStorage(window);
            if (storage) clearQuoteSession(storage);
          }
        }
        return false;
      }
      quoteCommandKeys.complete(scope, input);
      if (!applyQuote(result.data)) scheduleQuoteRefresh(1_500);
      return true;
    } catch {
      if (!disposed && !controller.signal.aborted) {
        commandError.value =
          "Změnu se nepodařilo uložit. Zkontrolujte připojení a zkuste to znovu.";
      }
      return false;
    } finally {
      if (commandController === controller) {
        commandController = undefined;
        commandPending.value = false;
      }
    }
  }

  function replaceConfiguration(
    items: ReplaceConfiguration["items"],
  ): Promise<boolean> {
    const input = { items };
    return runQuoteCommand("replace-configuration", input, (signal, key) =>
      $api.PUT("/automatic-quote-sessions/{sessionId}/configuration", {
        body: input,
        headers: { Authorization: `Bearer ${sessionToken.value}` },
        params: {
          header: { "Idempotency-Key": key },
          path: { sessionId: quote.value!.sessionId },
        },
        signal,
      }),
    );
  }

  function decideRisk(decision: RiskDecision): Promise<boolean> {
    return runQuoteCommand("risk-decision", decision, (signal, key) =>
      $api.POST("/automatic-quote-sessions/{sessionId}/risk-decisions", {
        body: decision,
        headers: { Authorization: `Bearer ${sessionToken.value}` },
        params: {
          header: { "Idempotency-Key": key },
          path: { sessionId: quote.value!.sessionId },
        },
        signal,
      }),
    );
  }

  function removeItem(ordinal: number): Promise<boolean> {
    const input = { ordinal };
    return runQuoteCommand("remove-item", input, (signal, key) =>
      $api.DELETE(
        "/automatic-quote-sessions/{sessionId}/items/{ordinal}/configuration",
        {
          headers: { Authorization: `Bearer ${sessionToken.value}` },
          params: {
            header: { "Idempotency-Key": key },
            path: { ordinal, sessionId: quote.value!.sessionId },
          },
          signal,
        },
      ),
    );
  }

  function selectDestination(
    destination: DeliveryDestination,
  ): Promise<boolean> {
    return runQuoteCommand("delivery-destination", destination, (signal, key) =>
      $api.PUT("/automatic-quote-sessions/{sessionId}/delivery-destination", {
        body: destination,
        headers: { Authorization: `Bearer ${sessionToken.value}` },
        params: {
          header: { "Idempotency-Key": key },
          path: { sessionId: quote.value!.sessionId },
        },
        signal,
      }),
    );
  }

  function setExpress(requested: boolean): Promise<boolean> {
    const input = { requested };
    return runQuoteCommand("express", input, (signal, key) =>
      $api.PUT("/automatic-quote-sessions/{sessionId}/express", {
        body: input,
        headers: { Authorization: `Bearer ${sessionToken.value}` },
        params: {
          header: { "Idempotency-Key": key },
          path: { sessionId: quote.value!.sessionId },
        },
        signal,
      }),
    );
  }

  function prepareQuote(): Promise<boolean> {
    const input = {
      configurationRevision: quote.value?.configurationRevision,
    };
    return runQuoteCommand("prepare", input, (signal, key) =>
      $api.POST("/automatic-quote-sessions/{sessionId}/prepare", {
        headers: { Authorization: `Bearer ${sessionToken.value}` },
        params: {
          header: { "Idempotency-Key": key },
          path: { sessionId: quote.value!.sessionId },
        },
        signal,
      }),
    );
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
      if (!uploadIntent) {
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
        uploadIntent = intent.data;
      }

      if (!confirmedUpload) {
        if (transferCheckpoint.needsPut()) {
          await uploadFile({
            file,
            onProgress: (progress) => {
              uploadProgress.value = progress;
            },
            requiredHeaders: uploadIntent.requiredHeaders,
            signal,
            uploadUrl: uploadIntent.uploadUrl,
          });
          transferCheckpoint.markPutCompleted();
        }
        uploadProgress.value = 100;

        const confirmation = await $api.POST(
          "/storage/uploads/{uploadId}/confirm",
          {
            params: { path: { uploadId: uploadIntent.uploadId } },
            headers: {
              Authorization: `Bearer ${uploadIntent.accessToken}`,
            },
            signal,
          },
        );
        if (!confirmation.response.ok || !confirmation.data) {
          if (
            isTerminalUploadConfirmationStatus(confirmation.response.status)
          ) {
            discardUploadCheckpoint();
          }
          throw new Error(
            requestMessage(confirmation.response.status, "confirm"),
          );
        }
        confirmedUpload = confirmation.data;
      }

      if (!createdSession) {
        const created = await $api.POST("/automatic-quote-sessions", {
          body: { attribution: { channel: "web-upload" } },
          params: {
            header: { "Idempotency-Key": commandKeys.createSession() },
          },
          signal,
        });
        if (!created.response.ok || !created.data) {
          throw new Error(requestMessage(created.response.status, "session"));
        }
        createdSession = created.data;
      }

      const attached = await $api.POST(
        "/automatic-quote-sessions/{sessionId}/model-files",
        {
          body: {
            modelFileId: confirmedUpload.assetId,
            uploadToken: uploadIntent.accessToken,
          },
          headers: {
            Authorization: `Bearer ${createdSession.sessionToken}`,
          },
          params: {
            header: { "Idempotency-Key": commandKeys.attachModel() },
            path: { sessionId: createdSession.sessionId },
          },
          signal,
        },
      );
      if (!attached.response.ok || !attached.data) {
        if (isTerminalAttachmentStatus(attached.response.status)) {
          discardAttachmentCheckpoint();
        }
        throw new Error(requestMessage(attached.response.status, "attach"));
      }

      sessionToken.value = createdSession.sessionToken;
      restoredFilename.value = file.name;
      selectedFile.value = undefined;
      sha256.value = undefined;
      if (import.meta.client) {
        const storage = getSessionStorage(window);
        if (storage) {
          saveQuoteSession(storage, {
            expiresAt: attached.data.expiresAt,
            filename: file.name,
            publicReference: attached.data.publicReference,
            sessionId: attached.data.sessionId,
            sessionToken: createdSession.sessionToken,
          });
        }
      }
      if (!applyQuote(attached.data)) {
        void refreshQuote();
      }
    } catch (error) {
      if (error instanceof UploadFailure && error.code === "REJECTED") {
        discardUploadCheckpoint();
      }
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
    const storage = getSessionStorage(window);
    if (!storage) return;
    const stored = loadQuoteSession(storage);
    if (!stored) return;

    restoredFilename.value = stored.filename;
    sessionToken.value = stored.sessionToken;
    quote.value = {
      bindingQuote: null,
      checkoutReady: false,
      configurationEditable: false,
      configurationOptions: [],
      configurationRevision: 0,
      deliveryOptions: [],
      quantityComparisons: [],
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

  onMounted(() => {
    disposed = false;
    void restoreSession();
  });
  onBeforeUnmount(() => {
    disposed = true;
    uploadController?.abort();
    commandController?.abort();
    stopPolling();
  });

  return {
    canUpload,
    cancelUpload,
    commandError,
    commandPending,
    decideRisk,
    errorMessage,
    filename,
    geometry,
    handoffMessage,
    metadata,
    phase,
    previewMessage,
    prepareQuote,
    quote,
    replaceConfiguration,
    removeItem,
    resetState,
    retry,
    selectDestination,
    selectFile,
    setExpress,
    startUpload,
    uploadProgress,
  };
}

function quoteCommandMessage(status: number): string {
  if (status === 409) {
    return "Konfigurace se mezitím změnila. Zkontrolujte aktuální volby a zkuste to znovu.";
  }
  if (status === 410) {
    return "Platnost kalkulace vypršela. Nahrajte model znovu.";
  }
  if (status === 401) {
    return "Přístup ke kalkulaci už není platný. Nahrajte model znovu.";
  }
  if (status === 422) {
    return "Vybraná kombinace už není dostupná. Zvolte jinou možnost.";
  }
  return "Změnu se nepodařilo uložit. Zkuste to znovu.";
}

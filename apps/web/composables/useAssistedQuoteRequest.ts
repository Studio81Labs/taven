import type { components } from "@taven/openapi-client";
import { sha256Hex } from "../utils/model-file";
import {
  validateQuotePhoto,
  type ValidatedQuotePhoto,
} from "../utils/quote-photo";
import { UploadFailure, uploadFile } from "../utils/upload-file";

type CreateQuoteRequest = components["schemas"]["CreateQuoteRequestDto"];
type CreatedQuoteRequest = components["schemas"]["QuoteRequestCreatedDto"];
type UploadIntent = components["schemas"]["UploadIntentResponseDto"];

export type AssistedQuoteRequestPhase =
  "creating" | "editing" | "error" | "success" | "uploading";

interface PreparedPhoto {
  file: File;
  metadata: ValidatedQuotePhoto;
  sha256: string;
}

interface PhotoCheckpoint {
  confirmed: boolean;
  intent?: UploadIntent;
  putCompleted: boolean;
}

interface LockedSubmission {
  body: CreateQuoteRequest;
  files: readonly File[];
  fingerprint: string;
}

function defaultIdempotencyKey(): string {
  return `quote-request-${crypto.randomUUID()}`;
}

export function createQuoteRequestCommandKey(
  createKey: () => string = defaultIdempotencyKey,
) {
  let fingerprint: string | undefined;
  let key: string | undefined;
  return {
    get(input: unknown): string {
      const nextFingerprint = JSON.stringify(input);
      if (fingerprint !== nextFingerprint) {
        fingerprint = nextFingerprint;
        key = createKey();
      }
      return (key ??= createKey());
    },
  };
}

export function assistedQuoteRequestMessage(
  status: number,
  stage: "confirm" | "create" | "intent",
): string {
  if (status === 429) {
    return stage === "create"
      ? "Limit nových poptávek je teď vyčerpaný. Počkejte prosím chvíli a odešlete stejnou poptávku znovu."
      : "Limit nahrávání fotografií je teď vyčerpaný. Poptávka je uložená; přílohy zkuste odeslat znovu za chvíli.";
  }
  if (status === 410) {
    return "Platnost nahrání fotografie vypršela. Poptávka je uložená; fotografii nahrajeme znovu.";
  }
  if (status === 401) {
    return "Oprávnění k této poptávce už není platné. Poznamenejte si její referenci a kontaktujte nás e-mailem.";
  }
  if (status === 409) {
    return stage === "create"
      ? "Odeslaná data se změnila během opakování požadavku. Obnovte stránku a vyplňte poptávku znovu."
      : "Kontrolní otisk fotografie nesouhlasí. Poptávka je uložená; vyberte fotografii znovu.";
  }
  if (status === 400) {
    return stage === "create"
      ? "Zkontrolujte povinná pole a formát kontaktních údajů."
      : "Fotografie nesplňuje podmínky nahrání. Použijte JPG, PNG nebo WebP do 20 MiB.";
  }
  return stage === "create"
    ? "Poptávku se nepodařilo odeslat. Zkontrolujte připojení a zkuste stejný požadavek znovu."
    : "Poptávka je uložená, ale fotografii se nepodařilo nahrát. Zkontrolujte připojení a zkuste to znovu.";
}

export function shouldRestartPhotoIntent(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 409 || status === 410;
}

export function isEditableCreateFailure(
  stage: "confirm" | "create" | "intent",
  status: number,
): boolean {
  return stage === "create" && status === 400;
}

export function isEditableAttachmentFailure(
  stage: "confirm" | "create" | "intent",
  status: number,
): boolean {
  return (
    (stage === "confirm" || stage === "intent") &&
    (status === 400 || status === 409)
  );
}

export function shouldUnlockAfterAttachmentPreparationFailure(input: {
  aborted: boolean;
  hasCreatedRequest: boolean;
  hasPreparedPhotos: boolean;
}): boolean {
  return !input.aborted && !input.hasCreatedRequest && !input.hasPreparedPhotos;
}

export function useAssistedQuoteRequest() {
  const { $api } = useNuxtApp();
  const phase = ref<AssistedQuoteRequestPhase>("editing");
  const created = shallowRef<CreatedQuoteRequest>();
  const errorMessage = ref<string>();
  const uploadProgress = ref(0);
  const activePhotoName = ref<string>();
  const attachmentsEditable = ref(false);
  const rejectedPhoto = shallowRef<File>();
  const submitted = ref(false);
  const requestKey = createQuoteRequestCommandKey();
  const photoCheckpoints = new Map<string, PhotoCheckpoint>();
  let lockedSubmission: LockedSubmission | undefined;
  let preparedPhotos: PreparedPhoto[] | undefined;
  let controller: AbortController | undefined;

  const pending = computed(
    () => phase.value === "creating" || phase.value === "uploading",
  );

  async function submit(
    body: CreateQuoteRequest,
    files: readonly File[],
  ): Promise<void> {
    if (pending.value) return;
    const fingerprint = JSON.stringify(body);
    if (!lockedSubmission) {
      lockedSubmission = { body, files: [...files], fingerprint };
      submitted.value = true;
    } else if (attachmentsEditable.value && created.value) {
      lockedSubmission = { ...lockedSubmission, files: [...files] };
      preparedPhotos = undefined;
      attachmentsEditable.value = false;
      rejectedPhoto.value = undefined;
    } else if (lockedSubmission.fingerprint !== fingerprint) {
      errorMessage.value =
        "Po zahájení odesílání už nelze měnit údaje. Zopakujte původní požadavek.";
      phase.value = "error";
      return;
    }
    await execute(lockedSubmission);
  }

  async function retry(): Promise<void> {
    if (!lockedSubmission || pending.value) return;
    await execute(lockedSubmission);
  }

  async function execute(submission: LockedSubmission): Promise<void> {
    controller?.abort();
    const activeController = new AbortController();
    controller = activeController;
    const signal = activeController.signal;
    errorMessage.value = undefined;
    uploadProgress.value = 0;
    activePhotoName.value = undefined;
    let currentPhoto: File | undefined;

    try {
      if (!preparedPhotos) {
        phase.value = "creating";
        const prepared: PreparedPhoto[] = [];
        for (const file of submission.files) {
          const metadata = validateQuotePhoto(file);
          prepared.push({
            file,
            metadata,
            sha256: await sha256Hex(await file.arrayBuffer()),
          });
        }
        preparedPhotos = prepared;
      }

      if (!created.value) {
        phase.value = "creating";
        const response = await $api.POST("/quote-requests", {
          body: submission.body,
          params: {
            header: {
              "Idempotency-Key": requestKey.get(submission.body),
            },
          },
          signal,
        });
        if (!response.response.ok || !response.data) {
          throw new RequestFailure(
            "create",
            response.response.status,
            assistedQuoteRequestMessage(response.response.status, "create"),
          );
        }
        created.value = response.data;
      }

      phase.value = "uploading";
      for (let index = 0; index < preparedPhotos.length; index += 1) {
        const photo = preparedPhotos[index]!;
        currentPhoto = photo.file;
        const identity = `${photo.file.lastModified}:${photo.metadata.originalFilename}:${photo.metadata.sizeBytes}:${photo.sha256}`;
        const checkpoint = photoCheckpoints.get(identity) ?? {
          confirmed: false,
          putCompleted: false,
        };
        photoCheckpoints.set(identity, checkpoint);
        if (checkpoint.confirmed) continue;

        activePhotoName.value = photo.metadata.originalFilename;
        if (!checkpoint.intent) {
          const intent = await $api.POST("/storage/uploads/photos", {
            body: {
              contentType: photo.metadata.contentType,
              kind: "QUOTE_REFERENCE",
              originalFilename: photo.metadata.originalFilename,
              scopeId: created.value.requestId,
              scopeKind: "QUOTE_REQUEST",
              sha256: photo.sha256,
              sizeBytes: photo.metadata.sizeBytes,
            },
            headers: {
              Authorization: `Bearer ${created.value.requestToken}`,
            },
            signal,
          });
          if (!intent.response.ok || !intent.data) {
            if (isEditableAttachmentFailure("intent", intent.response.status)) {
              photoCheckpoints.delete(identity);
            }
            throw new RequestFailure(
              "intent",
              intent.response.status,
              assistedQuoteRequestMessage(intent.response.status, "intent"),
            );
          }
          checkpoint.intent = intent.data;
          checkpoint.putCompleted = false;
        }

        if (!checkpoint.putCompleted) {
          try {
            await uploadFile({
              file: photo.file,
              onProgress: (progress) => {
                uploadProgress.value = Math.round(
                  ((index + progress / 100) / preparedPhotos!.length) * 100,
                );
              },
              requiredHeaders: checkpoint.intent.requiredHeaders,
              signal,
              uploadUrl: checkpoint.intent.uploadUrl,
            });
            checkpoint.putCompleted = true;
          } catch (error) {
            if (
              error instanceof UploadFailure &&
              shouldRestartPhotoIntent(error.status)
            ) {
              checkpoint.intent = undefined;
              checkpoint.putCompleted = false;
            }
            throw error;
          }
        }

        const confirmation = await $api.POST(
          "/storage/uploads/{uploadId}/confirm",
          {
            headers: {
              Authorization: `Bearer ${checkpoint.intent.accessToken}`,
            },
            params: { path: { uploadId: checkpoint.intent.uploadId } },
            signal,
          },
        );
        if (!confirmation.response.ok || !confirmation.data) {
          if (shouldRestartPhotoIntent(confirmation.response.status)) {
            checkpoint.intent = undefined;
            checkpoint.putCompleted = false;
          }
          if (
            isEditableAttachmentFailure("confirm", confirmation.response.status)
          ) {
            photoCheckpoints.delete(identity);
          }
          throw new RequestFailure(
            "confirm",
            confirmation.response.status,
            assistedQuoteRequestMessage(
              confirmation.response.status,
              "confirm",
            ),
          );
        }
        checkpoint.confirmed = true;
        uploadProgress.value = Math.round(
          ((index + 1) / preparedPhotos.length) * 100,
        );
      }

      activePhotoName.value = undefined;
      rejectedPhoto.value = undefined;
      uploadProgress.value = 100;
      phase.value = "success";
    } catch (error) {
      if (
        shouldUnlockAfterAttachmentPreparationFailure({
          aborted: signal.aborted,
          hasCreatedRequest: Boolean(created.value),
          hasPreparedPhotos: preparedPhotos !== undefined,
        })
      ) {
        lockedSubmission = undefined;
        photoCheckpoints.clear();
        submitted.value = false;
      }

      if (signal.aborted) {
        errorMessage.value = created.value
          ? "Nahrávání bylo pozastavené. Poptávka je uložená a fotografie můžete odeslat znovu."
          : "Odesílání bylo pozastavené. Stejnou poptávku můžete zkusit znovu.";
      } else if (error instanceof RequestFailure) {
        errorMessage.value = error.message;
        if (isEditableCreateFailure(error.stage, error.status)) {
          lockedSubmission = undefined;
          preparedPhotos = undefined;
          photoCheckpoints.clear();
          submitted.value = false;
        } else if (
          created.value &&
          isEditableAttachmentFailure(error.stage, error.status)
        ) {
          attachmentsEditable.value = true;
          rejectedPhoto.value = currentPhoto;
        }
      } else if (error instanceof Error) {
        errorMessage.value = created.value
          ? `Poptávka je uložená, ale přílohy čekají na dokončení. ${error.message}`
          : error.message;
      } else {
        errorMessage.value = assistedQuoteRequestMessage(
          500,
          created.value ? "intent" : "create",
        );
      }
      phase.value = "error";
    } finally {
      if (controller === activeController) controller = undefined;
    }
  }

  function cancel(): void {
    controller?.abort();
  }

  onBeforeUnmount(cancel);

  return {
    activePhotoName,
    attachmentsEditable,
    cancel,
    created,
    errorMessage,
    pending,
    phase,
    retry,
    rejectedPhoto,
    submit,
    submitted,
    uploadProgress,
  };
}

class RequestFailure extends Error {
  constructor(
    readonly stage: "confirm" | "create" | "intent",
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RequestFailure";
  }
}

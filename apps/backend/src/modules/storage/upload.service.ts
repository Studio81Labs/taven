import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ModelFileFormat,
  PhotoAssetKind,
  PhotoScopeKind,
  RetentionHold,
  UploadAssetKind,
  UploadIntentStatus,
} from "@prisma/client";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import type {
  ConfirmedUploadResponseDto,
  InitiateModelUploadDto,
  InitiatePhotoUploadDto,
  ReorderEligibilityResponseDto,
  SignedDownloadResponseDto,
  UploadIntentResponseDto,
} from "./storage.dto";
import { OBJECT_STORAGE, type ObjectStorage } from "./object-storage.port";
import {
  OBJECT_STORAGE_CONFIG,
  type ObjectStorageConfig,
} from "./storage.config";
import {
  modelSourceObjectKey,
  photoOriginalObjectKey,
  quarantineObjectKey,
} from "./storage-keys";
import {
  UploadValidationError,
  MAX_3MF_CENTRAL_DIRECTORY_SIZE,
  MAX_ZIP_END_RECORD_SIZE,
  inspect3mfCentralDirectory,
  inspect3mfEndRecord,
  validateFileSignature,
  validateModelUploadMetadata,
  validatePhotoUploadMetadata,
  type ValidatedUploadMetadata,
} from "./upload-validation";

const RETENTION_DAYS = 90;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MAX_SIGNATURE_PREFIX_BYTES = 512;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type UploadIntentRecord = Awaited<
  ReturnType<PrismaService["uploadIntent"]["findUnique"]>
>;

@Injectable()
export class UploadService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly objects: ObjectStorage,
    @Inject(OBJECT_STORAGE_CONFIG)
    private readonly storageConfig: ObjectStorageConfig,
  ) {}

  async initiateModelUpload(
    input: InitiateModelUploadDto,
  ): Promise<UploadIntentResponseDto> {
    const uploadId = randomUUID();
    const assetId = randomUUID();
    const metadata = this.validateModelInput(input, uploadId);
    const token = createCapabilityToken();
    const expiresAt = this.intentExpiry();
    const quarantineKey = quarantineObjectKey(uploadId);
    const finalKey = modelSourceObjectKey(assetId);

    await this.prisma.uploadIntent.create({
      data: {
        id: uploadId,
        assetKind: UploadAssetKind.MODEL_FILE,
        capabilityTokenHash: hashToken(token),
        originalFilename: metadata.displayFilename,
        modelFormat: toModelFileFormat(metadata.format),
        intendedAssetId: assetId,
        expectedContentType: metadata.contentType,
        expectedSizeBytes: BigInt(metadata.sizeBytes),
        expectedContentHash: metadata.sha256,
        quarantineObjectKey: quarantineKey,
        finalObjectKey: finalKey,
        expiresAt,
      },
    });

    return this.createUploadResponse(
      uploadId,
      assetId,
      token,
      quarantineKey,
      metadata,
      expiresAt,
    );
  }

  async initiatePhotoUpload(
    input: InitiatePhotoUploadDto,
    authorization?: string,
  ): Promise<UploadIntentResponseDto> {
    const uploadId = randomUUID();
    const assetId = randomUUID();
    const metadata = this.validatePhotoInput(input);
    const { photoKind, scopeKind } = validatePhotoScope(input);
    const scopeToken = bearerToken(authorization);
    const token = createCapabilityToken();
    const expiresAt = this.intentExpiry();
    const quarantineKey = quarantineObjectKey(uploadId);
    const finalKey = photoOriginalObjectKey(assetId);

    await this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<
        Array<{
          customer_id: string | null;
          session_customer_id: string | null;
          public_token_hash: string;
          status: string;
          expires_at: Date;
        }>
      >`
        SELECT request.customer_id, session.customer_id AS session_customer_id,
               session.public_token_hash, session.status::text, session.expires_at
        FROM quote_requests request
        JOIN quote_sessions session ON session.id = request.quote_session_id
        WHERE request.id = ${metadata.scopeId}::uuid
        FOR SHARE OF request, session
      `;
      const scope = rows[0];
      if (
        !scope ||
        scope.status !== "OPEN" ||
        scope.expires_at.getTime() <= Date.now() ||
        !matchesTokenHash(scopeToken, scope.public_token_hash)
      ) {
        throw new UnauthorizedException("Quote-session capability is invalid");
      }
      await transaction.uploadIntent.create({
        data: {
          id: uploadId,
          customerId: scope.customer_id ?? scope.session_customer_id,
          assetKind: UploadAssetKind.PHOTO_ASSET,
          capabilityTokenHash: hashToken(token),
          originalFilename: metadata.displayFilename,
          photoKind,
          photoScopeKind: scopeKind,
          photoScopeId: metadata.scopeId,
          intendedAssetId: assetId,
          expectedContentType: metadata.contentType,
          expectedSizeBytes: BigInt(metadata.sizeBytes),
          expectedContentHash: metadata.sha256,
          quarantineObjectKey: quarantineKey,
          finalObjectKey: finalKey,
          expiresAt,
        },
      });
    });

    return this.createUploadResponse(
      uploadId,
      assetId,
      token,
      quarantineKey,
      metadata,
      expiresAt,
    );
  }

  async confirmUpload(
    uploadId: string,
    authorization?: string,
  ): Promise<ConfirmedUploadResponseDto> {
    assertUuid(uploadId, "uploadId");
    const token = bearerToken(authorization);
    let intent = await this.prisma.uploadIntent.findUnique({
      where: { id: uploadId },
    });
    assertCapability(intent, token);
    if (intent.status === UploadIntentStatus.CONFIRMED) {
      return confirmedResponse(intent);
    }
    if (intent.status !== UploadIntentStatus.PENDING) {
      throw new ConflictException(
        `Upload intent is ${intent.status.toLowerCase()}`,
      );
    }
    if (intent.expiresAt.getTime() <= Date.now()) {
      await this.expirePendingIntent(intent.id);
      throw new GoneException("Upload intent expired");
    }

    try {
      const stored = await this.objects.headObject(intent.quarantineObjectKey);
      if (!stored)
        throw new UploadValidationError(
          "INVALID_SIGNATURE",
          "Upload is not present",
        );
      if (
        stored.contentLength !== Number(intent.expectedSizeBytes) ||
        normalizeContentType(stored.contentType) !==
          intent.expectedContentType ||
        (stored.contentHash !== null &&
          stored.contentHash !== intent.expectedContentHash)
      ) {
        throw new UploadValidationError(
          "INVALID_SIGNATURE",
          "Stored object metadata does not match the upload intent",
        );
      }
      if (stored.contentHash !== intent.expectedContentHash) {
        throw new UploadValidationError(
          "INVALID_SHA256",
          "Stored object is missing its verified SHA-256 checksum",
        );
      }
      await this.validateStoredSignature(intent);
    } catch (error) {
      if (error instanceof UploadValidationError) {
        await this.rejectPendingIntent(intent.id, error);
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }

    await this.objects.copyObject(
      intent.quarantineObjectKey,
      intent.finalObjectKey,
    );

    const confirmedIntentId = intent.id;
    intent = await this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM upload_intents WHERE id = ${confirmedIntentId}::uuid FOR UPDATE
      `;
      if (rows.length !== 1)
        throw new UnauthorizedException("Upload capability is invalid");
      const current = await transaction.uploadIntent.findUniqueOrThrow({
        where: { id: confirmedIntentId },
      });
      assertCapability(current, token);
      if (current.status === UploadIntentStatus.CONFIRMED) return current;
      if (
        current.status !== UploadIntentStatus.PENDING ||
        current.expiresAt.getTime() <= Date.now()
      ) {
        if (current.status === UploadIntentStatus.PENDING) {
          await transaction.uploadIntent.update({
            where: { id: current.id },
            data: { status: UploadIntentStatus.EXPIRED },
          });
        }
        throw new GoneException("Upload intent expired");
      }

      const uploadedAt = new Date();
      const deleteAfter = addRetention(uploadedAt);
      if (current.assetKind === UploadAssetKind.MODEL_FILE) {
        if (!current.modelFormat || !current.originalFilename) {
          throw new ConflictException("Model upload intent is incomplete");
        }
        await transaction.modelFile.create({
          data: {
            id: current.intendedAssetId,
            format: current.modelFormat,
            originalFilename: current.originalFilename,
            storageObjectKey: current.finalObjectKey,
            contentHash: current.expectedContentHash,
            sizeBytes: current.expectedSizeBytes,
            uploadedAt,
            sourceDeleteAfter: deleteAfter,
            sourceRetentionDays: RETENTION_DAYS,
          },
        });
        return transaction.uploadIntent.update({
          where: { id: current.id },
          data: {
            status: UploadIntentStatus.CONFIRMED,
            confirmedModelFileId: current.intendedAssetId,
            confirmedAt: uploadedAt,
          },
        });
      }

      if (
        !current.photoKind ||
        !current.photoScopeKind ||
        !current.photoScopeId
      ) {
        throw new ConflictException("Photo upload intent is incomplete");
      }
      await transaction.photoAsset.create({
        data: {
          id: current.intendedAssetId,
          kind: current.photoKind,
          scopeKind: current.photoScopeKind,
          scopeId: current.photoScopeId,
          storageObjectKey: current.finalObjectKey,
          contentHash: current.expectedContentHash,
          mediaType: current.expectedContentType,
          sizeBytes: current.expectedSizeBytes,
          uploadedAt,
          retentionDays: RETENTION_DAYS,
          photoDeleteAfter: deleteAfter,
        },
      });
      return transaction.uploadIntent.update({
        where: { id: current.id },
        data: {
          status: UploadIntentStatus.CONFIRMED,
          confirmedPhotoAssetId: current.intendedAssetId,
          confirmedAt: uploadedAt,
        },
      });
    });

    await this.objects.deleteObjects([intent.quarantineObjectKey]).catch(() => {
      // The durable upload-intent cleanup job will retry this idempotently.
    });
    return confirmedResponse(intent);
  }

  async createModelDownload(
    modelFileId: string,
    authorization?: string,
  ): Promise<SignedDownloadResponseDto> {
    assertUuid(modelFileId, "modelFileId");
    await this.authorizedModelIntent(modelFileId, authorization);
    const model = await this.prisma.modelFile.findUnique({
      where: { id: modelFileId },
    });
    if (!model) throw new UnauthorizedException("Upload capability is invalid");
    const expiresAt = availableDownloadDeadline(
      model.deletedAt,
      model.retentionHold,
      model.sourceDeleteAfter,
      this.storageConfig.signedUrlTtlSeconds,
    );
    const signed = await this.objects.createDownloadUrl({
      objectKey: model.storageObjectKey,
      expiresAt,
    });
    return {
      downloadUrl: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  async createPhotoDownload(
    photoAssetId: string,
    authorization?: string,
  ): Promise<SignedDownloadResponseDto> {
    assertUuid(photoAssetId, "photoAssetId");
    await this.authorizedPhotoIntent(photoAssetId, authorization);
    const photo = await this.prisma.photoAsset.findUnique({
      where: { id: photoAssetId },
    });
    if (!photo) throw new UnauthorizedException("Upload capability is invalid");
    const expiresAt = availableDownloadDeadline(
      photo.deletedAt,
      photo.retentionHold,
      photo.photoDeleteAfter,
      this.storageConfig.signedUrlTtlSeconds,
    );
    const signed = await this.objects.createDownloadUrl({
      objectKey: photo.storageObjectKey,
      expiresAt,
    });
    return {
      downloadUrl: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  async getReorderEligibility(
    modelFileId: string,
    authorization?: string,
  ): Promise<ReorderEligibilityResponseDto> {
    assertUuid(modelFileId, "modelFileId");
    await this.authorizedModelIntent(modelFileId, authorization);
    const model = await this.prisma.modelFile.findUnique({
      where: { id: modelFileId },
    });
    if (!model) {
      return {
        eligible: false,
        reason: "SOURCE_MISSING",
        sourceAvailable: false,
      };
    }
    if (model.deletedAt) {
      return {
        eligible: false,
        reason: "SOURCE_DELETED",
        sourceAvailable: false,
      };
    }
    if (
      model.retentionHold === RetentionHold.NONE &&
      model.sourceDeleteAfter.getTime() <= Date.now()
    ) {
      return {
        eligible: false,
        reason: "SOURCE_EXPIRED",
        sourceAvailable: false,
      };
    }
    if (!(await this.objects.headObject(model.storageObjectKey))) {
      return {
        eligible: false,
        reason: "SOURCE_MISSING",
        sourceAvailable: false,
      };
    }
    return { eligible: true, reason: "AVAILABLE", sourceAvailable: true };
  }

  private validateModelInput(
    input: InitiateModelUploadDto,
    uploadId: string,
  ): ValidatedUploadMetadata {
    try {
      return validateModelUploadMetadata({
        scopeId: uploadId,
        extension: extensionOf(input.originalFilename),
        format: input.format,
        contentType: input.contentType,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        displayFilename: input.originalFilename,
      });
    } catch (error) {
      throw validationException(error);
    }
  }

  private validatePhotoInput(
    input: InitiatePhotoUploadDto,
  ): ValidatedUploadMetadata {
    try {
      return validatePhotoUploadMetadata({
        scopeId: input.scopeId,
        extension: extensionOf(input.originalFilename),
        contentType: input.contentType,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        displayFilename: input.originalFilename,
      });
    } catch (error) {
      throw validationException(error);
    }
  }

  private async validateStoredSignature(
    intent: NonNullable<UploadIntentRecord>,
  ): Promise<void> {
    const metadata = this.metadataFromIntent(intent);
    const objectSize = Number(intent.expectedSizeBytes);
    if (metadata.format !== "3MF") {
      const prefix = await this.objects.readObjectRange(
        intent.quarantineObjectKey,
        0,
        Math.min(objectSize, MAX_SIGNATURE_PREFIX_BYTES),
      );
      validateFileSignature(metadata.format, prefix, objectSize);
      return;
    }

    const tailSize = Math.min(objectSize, MAX_ZIP_END_RECORD_SIZE);
    const tailOffset = objectSize - tailSize;
    const tail = await this.objects.readObjectRange(
      intent.quarantineObjectKey,
      tailOffset,
      tailSize,
    );
    const end = inspect3mfEndRecord(tail, objectSize, tailOffset);
    if (end.centralDirectorySize > MAX_3MF_CENTRAL_DIRECTORY_SIZE) {
      throw new UploadValidationError(
        "ARCHIVE_LIMIT_EXCEEDED",
        "3MF ZIP central directory exceeds the inspection limit",
      );
    }
    const directory = await this.objects.readObjectRange(
      intent.quarantineObjectKey,
      end.centralDirectoryOffset,
      end.centralDirectorySize,
    );
    inspect3mfCentralDirectory(directory, end.entries);
  }

  private metadataFromIntent(
    intent: NonNullable<UploadIntentRecord>,
  ): ValidatedUploadMetadata {
    if (!intent.originalFilename) {
      throw new UploadValidationError(
        "UNSAFE_FILENAME",
        "Upload filename is missing",
      );
    }
    const input = {
      scopeId: intent.photoScopeId ?? intent.id,
      extension: extensionOf(intent.originalFilename),
      contentType: intent.expectedContentType,
      sha256: intent.expectedContentHash,
      sizeBytes: Number(intent.expectedSizeBytes),
      displayFilename: intent.originalFilename,
    };
    return intent.assetKind === UploadAssetKind.MODEL_FILE
      ? validateModelUploadMetadata({
          ...input,
          format: fromModelFileFormat(intent.modelFormat),
        })
      : validatePhotoUploadMetadata(input);
  }

  private async createUploadResponse(
    uploadId: string,
    assetId: string,
    token: string,
    quarantineKey: string,
    metadata: ValidatedUploadMetadata,
    expiresAt: Date,
  ): Promise<UploadIntentResponseDto> {
    if (expiresAt.getTime() <= Date.now()) {
      await this.expirePendingIntent(uploadId);
      throw new GoneException("Upload intent expired before URL signing");
    }
    const signed = await this.objects.createUploadUrl({
      objectKey: quarantineKey,
      contentType: metadata.contentType,
      contentHash: metadata.sha256,
      contentLength: metadata.sizeBytes,
      expiresAt,
    });
    return {
      uploadId,
      assetId,
      accessToken: token,
      uploadUrl: signed.url,
      expiresAt: expiresAt.toISOString(),
      requiredHeaders: signed.requiredHeaders,
    };
  }

  private intentExpiry(): Date {
    return new Date(
      Date.now() + this.storageConfig.signedUrlTtlSeconds * 1_000,
    );
  }

  private async authorizedModelIntent(
    modelFileId: string,
    authorization?: string,
  ) {
    const token = bearerToken(authorization);
    const intent = await this.prisma.uploadIntent.findUnique({
      where: { confirmedModelFileId: modelFileId },
    });
    assertCapability(intent, token);
    return intent;
  }

  private async authorizedPhotoIntent(
    photoAssetId: string,
    authorization?: string,
  ) {
    const token = bearerToken(authorization);
    const intent = await this.prisma.uploadIntent.findUnique({
      where: { confirmedPhotoAssetId: photoAssetId },
    });
    assertCapability(intent, token);
    return intent;
  }

  private async expirePendingIntent(id: string): Promise<void> {
    await this.prisma.uploadIntent.updateMany({
      where: { id, status: UploadIntentStatus.PENDING },
      data: { status: UploadIntentStatus.EXPIRED },
    });
  }

  private async rejectPendingIntent(
    id: string,
    error: UploadValidationError,
  ): Promise<void> {
    const intent = await this.prisma.uploadIntent.update({
      where: { id },
      data: {
        status: UploadIntentStatus.REJECTED,
        failureReason: `${error.code}:${error.message}`,
      },
    });
    await this.objects
      .deleteObjects([intent.quarantineObjectKey, intent.finalObjectKey])
      .catch(() => {
        // The upload-intent retention job remains the durable cleanup fallback.
      });
  }
}

function extensionOf(filename: string): string {
  const index = typeof filename === "string" ? filename.lastIndexOf(".") : -1;
  return index < 0 ? "" : filename.slice(index + 1);
}

function normalizeContentType(value: string): string {
  return value.trim().toLowerCase().split(";", 1)[0] ?? "";
}

function toModelFileFormat(format: string): ModelFileFormat {
  if (format === "STL") return ModelFileFormat.STL;
  if (format === "STEP") return ModelFileFormat.STEP;
  if (format === "3MF") return ModelFileFormat.THREE_MF;
  throw new BadRequestException("Unsupported model format");
}

function fromModelFileFormat(format: ModelFileFormat | null): string {
  if (format === ModelFileFormat.STL) return "STL";
  if (format === ModelFileFormat.STEP) return "STEP";
  if (format === ModelFileFormat.THREE_MF) return "3MF";
  throw new UploadValidationError(
    "UNSUPPORTED_FORMAT",
    "Model format is missing",
  );
}

function validatePhotoScope(input: InitiatePhotoUploadDto): {
  photoKind: PhotoAssetKind;
  scopeKind: PhotoScopeKind;
} {
  if (input.kind === "QUOTE_REFERENCE" && input.scopeKind === "QUOTE_REQUEST") {
    return {
      photoKind: PhotoAssetKind.QUOTE_REFERENCE,
      scopeKind: PhotoScopeKind.QUOTE_REQUEST,
    };
  }
  throw new BadRequestException(
    "Only quote-reference uploads are available through the public API",
  );
}

function validationException(error: unknown): BadRequestException {
  if (error instanceof UploadValidationError) {
    return new BadRequestException({
      code: error.code,
      message: error.message,
    });
  }
  if (error instanceof BadRequestException) return error;
  return new BadRequestException("Invalid upload metadata");
}

function createCapabilityToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearerToken(authorization?: string): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  if (!match?.[1])
    throw new UnauthorizedException("Upload capability is invalid");
  return match[1];
}

function assertCapability(
  intent: UploadIntentRecord,
  token: string,
): asserts intent is NonNullable<UploadIntentRecord> {
  if (!intent) throw new UnauthorizedException("Upload capability is invalid");
  if (!matchesTokenHash(token, intent.capabilityTokenHash)) {
    throw new UnauthorizedException("Upload capability is invalid");
  }
}

function matchesTokenHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertUuid(value: string, name: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${name} must be a lowercase UUID`);
  }
}

function addRetention(uploadedAt: Date): Date {
  return new Date(uploadedAt.getTime() + RETENTION_DAYS * DAY_MILLISECONDS);
}

function confirmedResponse(
  intent: NonNullable<UploadIntentRecord>,
): ConfirmedUploadResponseDto {
  if (!intent.confirmedAt)
    throw new ConflictException("Confirmed upload is incomplete");
  const assetId = intent.confirmedModelFileId ?? intent.confirmedPhotoAssetId;
  if (!assetId) throw new ConflictException("Confirmed upload is incomplete");
  return {
    uploadId: intent.id,
    assetId,
    assetKind: intent.assetKind,
    uploadedAt: intent.confirmedAt.toISOString(),
    deleteAfter: addRetention(intent.confirmedAt).toISOString(),
  };
}

function availableDownloadDeadline(
  deletedAt: Date | null,
  hold: RetentionHold,
  deleteAfter: Date,
  configuredTtl: number,
): Date {
  if (deletedAt) throw new GoneException("Stored asset was deleted");
  const configuredDeadline = Date.now() + configuredTtl * 1_000;
  if (hold !== RetentionHold.NONE) return new Date(configuredDeadline);
  if (deleteAfter.getTime() <= Date.now())
    throw new GoneException("Stored asset expired");
  return new Date(Math.min(configuredDeadline, deleteAfter.getTime()));
}

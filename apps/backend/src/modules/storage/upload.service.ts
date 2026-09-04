import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ModelFileFormat,
  PhotoAssetKind,
  PhotoScopeKind,
  Prisma,
  RetentionHold,
  UploadAssetKind,
  UploadIntentStatus,
} from "@prisma/client";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, crc32 } from "node:zlib";
import { assertQuotePhotoUploadsEnabled } from "../../launch-approval-gates";
import { PrismaService } from "../../prisma/prisma.service";
import type {
  ConfirmedUploadResponseDto,
  InitiateModelUploadDto,
  InitiatePhotoUploadDto,
  ReorderEligibilityResponseDto,
  SignedDownloadResponseDto,
  UploadIntentResponseDto,
} from "./storage.dto";
import {
  OBJECT_STORAGE,
  ObjectStorageDeadlineError,
  type ObjectStorage,
} from "./object-storage.port";
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
  MAX_3MF_ENTRY_SIZE,
  MAX_3MF_TOTAL_SIZE,
  MAX_3MF_CENTRAL_DIRECTORY_SIZE,
  MAX_ZIP_END_RECORD_SIZE,
  inspect3mfDataDescriptor,
  inspect3mfCentralDirectory,
  inspect3mfEndRecord,
  inspect3mfLocalEntryHeader,
  threeMfLocalHeaderSize,
  validate3mfLocalEntryRanges,
  validateFileSignature,
  validateModelUploadMetadata,
  validatePhotoUploadMetadata,
  type ThreeMfEntry,
  type ValidatedUploadMetadata,
} from "./upload-validation";

const RETENTION_DAYS = 90;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MAX_SIGNATURE_PREFIX_BYTES = 512;
const MAX_3MF_LOCAL_HEADER_BYTES = 8 * 1024 * 1024;
const MAX_3MF_COMPRESSED_CHUNK_BYTES = 8 * 1024 * 1024;
const ANONYMOUS_UPLOAD_WINDOW_MILLISECONDS = 15 * 60 * 1_000;
const ANONYMOUS_UPLOAD_CLIENT_MAX_ISSUED = 20;
const ANONYMOUS_UPLOAD_CLIENT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const ANONYMOUS_UPLOAD_GLOBAL_MAX_ISSUED = 100;
const ANONYMOUS_UPLOAD_GLOBAL_MAX_BYTES = 10 * 1024 * 1024 * 1024;
const ANONYMOUS_UPLOAD_GLOBAL_SUBJECT = "global";
const ANONYMOUS_UPLOAD_LIMIT_CLEANUP_BATCH = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type UploadIntentRecord = Awaited<
  ReturnType<PrismaService["uploadIntent"]["findUnique"]>
>;

type AnonymousUploadLimitRow = {
  subject_hash: string;
  window_started_at: Date;
  window_expires_at: Date;
  issued_count: number;
  reserved_bytes: bigint;
};

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
    clientAddress: string,
  ): Promise<UploadIntentResponseDto> {
    const uploadId = randomUUID();
    const assetId = randomUUID();
    const metadata = this.validateModelInput(input, uploadId);
    const token = createCapabilityToken();
    const expiresAt = this.intentExpiry();
    const quarantineKey = quarantineObjectKey(uploadId);
    const finalKey = modelSourceObjectKey(assetId);
    const subjectHash = anonymousUploadSubject(
      this.storageConfig.uploadClientHashKey,
      "anonymous-model-upload",
      normalizeClientAddress(clientAddress),
    );

    await this.prisma.$transaction(async (transaction) => {
      await this.reserveAnonymousUpload(
        transaction,
        subjectHash,
        metadata.sizeBytes,
      );
      await transaction.uploadIntent.create({
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
          session_status: string;
          request_status: string;
          offer_expires_at: Date | null;
          expires_at: Date;
          observed_at: Date;
        }>
      >`
        SELECT request.customer_id, session.customer_id AS session_customer_id,
               session.public_token_hash,
               session.status::text AS session_status,
               request.status::text AS request_status,
               quote.expires_at AS offer_expires_at,
               session.expires_at,
               clock_timestamp() AS observed_at
        FROM quote_requests request
        JOIN quote_sessions session ON session.id = request.quote_session_id
        LEFT JOIN quotes quote ON quote.quote_request_id = request.id
        WHERE request.id = ${metadata.scopeId}::uuid
        FOR SHARE OF request, session
      `;
      const scope = rows[0];
      const requestAcceptsPhotos =
        scope?.request_status === "NEW" ||
        scope?.request_status === "IN_REVIEW" ||
        (scope?.request_status === "QUOTED" &&
          scope.offer_expires_at !== null &&
          scope.offer_expires_at.getTime() > scope.observed_at.getTime());
      if (
        !scope ||
        scope.session_status !== "OPEN" ||
        !requestAcceptsPhotos ||
        scope.expires_at.getTime() <= scope.observed_at.getTime() ||
        !matchesTokenHash(scopeToken, scope.public_token_hash)
      ) {
        throw new UnauthorizedException("Quote-session capability is invalid");
      }
      assertQuotePhotoUploadsEnabled();
      const subjectHash = anonymousUploadSubject(
        this.storageConfig.uploadClientHashKey,
        "quote-photo-upload",
        scope.public_token_hash,
      );
      await this.reserveAnonymousUpload(
        transaction,
        subjectHash,
        metadata.sizeBytes,
      );
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
    uploadId = normalizedUuid(uploadId, "uploadId");
    const token = bearerToken(authorization);
    let intent = await this.prisma.uploadIntent.findUnique({
      where: { id: uploadId },
    });
    assertCapability(intent, token);
    if (intent.status === UploadIntentStatus.CONFIRMED) {
      return this.confirmedResponse(intent);
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
    if (intent.assetKind === UploadAssetKind.PHOTO_ASSET) {
      assertQuotePhotoUploadsEnabled();
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

      let photoMetadata:
        | {
            kind: PhotoAssetKind;
            scopeKind: PhotoScopeKind;
            scopeId: string;
          }
        | undefined;
      if (current.assetKind === UploadAssetKind.PHOTO_ASSET) {
        if (
          !current.photoKind ||
          !current.photoScopeKind ||
          !current.photoScopeId
        ) {
          throw new ConflictException("Photo upload intent is incomplete");
        }
        photoMetadata = {
          kind: current.photoKind,
          scopeKind: current.photoScopeKind,
          scopeId: current.photoScopeId,
        };
        if (
          photoMetadata.kind === PhotoAssetKind.QUOTE_REFERENCE &&
          photoMetadata.scopeKind === PhotoScopeKind.QUOTE_REQUEST
        ) {
          const scopeRows = await transaction.$queryRaw<
            Array<{
              session_status: string;
              request_status: string;
              offer_expires_at: Date | null;
              session_expires_at: Date;
              observed_at: Date;
            }>
          >`
            SELECT session.status::text AS session_status,
                   request.status::text AS request_status,
                   quote.expires_at AS offer_expires_at,
                   session.expires_at AS session_expires_at,
                   clock_timestamp() AS observed_at
            FROM quote_requests request
            JOIN quote_sessions session ON session.id = request.quote_session_id
            LEFT JOIN quotes quote ON quote.quote_request_id = request.id
            WHERE request.id = ${photoMetadata.scopeId}::uuid
            FOR UPDATE OF request
          `;
          const scope = scopeRows[0];
          const requestAcceptsPhotos =
            scope?.request_status === "NEW" ||
            scope?.request_status === "IN_REVIEW" ||
            (scope?.request_status === "QUOTED" &&
              scope.offer_expires_at !== null &&
              scope.offer_expires_at.getTime() > scope.observed_at.getTime());
          if (
            !scope ||
            scope.session_status !== "OPEN" ||
            !requestAcceptsPhotos ||
            scope.session_expires_at.getTime() <= scope.observed_at.getTime()
          ) {
            throw new GoneException("Quote request no longer accepts photos");
          }
        }
      }

      // Keep the row lock through promotion. Cleanup claims the same row, so
      // it cannot delete the final key and then lose to an in-flight copy.
      await this.objects.copyObject(
        current.quarantineObjectKey,
        current.finalObjectKey,
      );

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

      if (!photoMetadata) {
        throw new ConflictException("Photo upload intent is incomplete");
      }

      await transaction.photoAsset.create({
        data: {
          id: current.intendedAssetId,
          kind: photoMetadata.kind,
          scopeKind: photoMetadata.scopeKind,
          scopeId: photoMetadata.scopeId,
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
    return this.confirmedResponse(intent);
  }

  async createModelDownload(
    modelFileId: string,
    authorization?: string,
  ): Promise<SignedDownloadResponseDto> {
    modelFileId = normalizedUuid(modelFileId, "modelFileId");
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
    return this.signDownload(model.storageObjectKey, expiresAt);
  }

  async createPhotoDownload(
    photoAssetId: string,
    authorization?: string,
  ): Promise<SignedDownloadResponseDto> {
    photoAssetId = normalizedUuid(photoAssetId, "photoAssetId");
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
    return this.signDownload(photo.storageObjectKey, expiresAt);
  }

  async createOperatorQuotePhotoDownload(
    quoteRequestId: string,
    photoAssetId: string,
  ): Promise<SignedDownloadResponseDto> {
    quoteRequestId = normalizedUuid(quoteRequestId, "requestId");
    photoAssetId = normalizedUuid(photoAssetId, "photoAssetId");
    const photo = await this.prisma.photoAsset.findFirst({
      where: {
        id: photoAssetId,
        kind: PhotoAssetKind.QUOTE_REFERENCE,
        scopeKind: PhotoScopeKind.QUOTE_REQUEST,
        scopeId: quoteRequestId,
      },
    });
    if (!photo) {
      throw new NotFoundException("Quote attachment was not found");
    }
    const expiresAt = availableDownloadDeadline(
      photo.deletedAt,
      photo.retentionHold,
      photo.photoDeleteAfter,
      this.storageConfig.signedUrlTtlSeconds,
    );
    return this.signDownload(photo.storageObjectKey, expiresAt);
  }

  async getReorderEligibility(
    modelFileId: string,
    authorization?: string,
  ): Promise<ReorderEligibilityResponseDto> {
    modelFileId = normalizedUuid(modelFileId, "modelFileId");
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

  private async reserveAnonymousUpload(
    transaction: Prisma.TransactionClient,
    subjectHash: string,
    sizeBytes: number,
  ): Promise<void> {
    const observedRows = await transaction.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now
    `;
    const observedAt = observedRows[0]?.now;
    if (!observedAt) throw new Error("database clock is unavailable");
    const windowExpiresAt = new Date(
      observedAt.getTime() + ANONYMOUS_UPLOAD_WINDOW_MILLISECONDS,
    );
    const global = await this.lockAnonymousUploadLimit(
      transaction,
      ANONYMOUS_UPLOAD_GLOBAL_SUBJECT,
      observedAt,
      windowExpiresAt,
    );
    const subject = await this.lockAnonymousUploadLimit(
      transaction,
      subjectHash,
      observedAt,
      windowExpiresAt,
    );
    const currentGlobal = await this.resetExpiredUploadLimit(
      transaction,
      global,
      observedAt,
      windowExpiresAt,
    );
    const currentSubject = await this.resetExpiredUploadLimit(
      transaction,
      subject,
      observedAt,
      windowExpiresAt,
    );

    if (
      currentGlobal.issued_count >= ANONYMOUS_UPLOAD_GLOBAL_MAX_ISSUED ||
      currentGlobal.reserved_bytes + BigInt(sizeBytes) >
        BigInt(ANONYMOUS_UPLOAD_GLOBAL_MAX_BYTES) ||
      currentSubject.issued_count >= ANONYMOUS_UPLOAD_CLIENT_MAX_ISSUED ||
      currentSubject.reserved_bytes + BigInt(sizeBytes) >
        BigInt(ANONYMOUS_UPLOAD_CLIENT_MAX_BYTES)
    ) {
      throw new HttpException(
        "Anonymous upload issuance limit is exhausted",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await transaction.anonymousUploadLimit.update({
      where: { subjectHash: ANONYMOUS_UPLOAD_GLOBAL_SUBJECT },
      data: {
        issuedCount: { increment: 1 },
        reservedBytes: { increment: BigInt(sizeBytes) },
      },
    });
    await transaction.anonymousUploadLimit.update({
      where: { subjectHash },
      data: {
        issuedCount: { increment: 1 },
        reservedBytes: { increment: BigInt(sizeBytes) },
      },
    });
    await transaction.$executeRaw`
      WITH expired AS (
        SELECT subject_hash
        FROM anonymous_upload_limits
        WHERE subject_hash <> ${ANONYMOUS_UPLOAD_GLOBAL_SUBJECT}
          AND window_expires_at <= ${observedAt}
        ORDER BY window_expires_at, subject_hash
        FOR UPDATE SKIP LOCKED
        LIMIT ${ANONYMOUS_UPLOAD_LIMIT_CLEANUP_BATCH}
      )
      DELETE FROM anonymous_upload_limits limits
      USING expired
      WHERE limits.subject_hash = expired.subject_hash
    `;
  }

  private async lockAnonymousUploadLimit(
    transaction: Prisma.TransactionClient,
    subjectHash: string,
    windowStartedAt: Date,
    windowExpiresAt: Date,
  ): Promise<AnonymousUploadLimitRow> {
    await transaction.$executeRaw`
      INSERT INTO anonymous_upload_limits (
        subject_hash, window_started_at, window_expires_at,
        issued_count, reserved_bytes, updated_at
      ) VALUES (
        ${subjectHash}, ${windowStartedAt}, ${windowExpiresAt}, 0, 0,
        clock_timestamp()
      )
      ON CONFLICT (subject_hash) DO NOTHING
    `;
    const rows = await transaction.$queryRaw<AnonymousUploadLimitRow[]>`
      SELECT subject_hash, window_started_at, window_expires_at,
             issued_count, reserved_bytes
      FROM anonymous_upload_limits
      WHERE subject_hash = ${subjectHash}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new Error("anonymous upload limit row is unavailable");
    return row;
  }

  private async resetExpiredUploadLimit(
    transaction: Prisma.TransactionClient,
    row: AnonymousUploadLimitRow,
    observedAt: Date,
    windowExpiresAt: Date,
  ): Promise<AnonymousUploadLimitRow> {
    if (row.window_expires_at.getTime() > observedAt.getTime()) return row;
    await transaction.anonymousUploadLimit.update({
      where: { subjectHash: row.subject_hash },
      data: {
        windowStartedAt: observedAt,
        windowExpiresAt,
        issuedCount: 0,
        reservedBytes: 0,
      },
    });
    return {
      ...row,
      window_started_at: observedAt,
      window_expires_at: windowExpiresAt,
      issued_count: 0,
      reserved_bytes: 0n,
    };
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
    const directoryBytes = await this.objects.readObjectRange(
      intent.quarantineObjectKey,
      end.centralDirectoryOffset,
      end.centralDirectorySize,
    );
    const directory = inspect3mfCentralDirectory(
      directoryBytes,
      end.entries,
      end.centralDirectoryOffset,
    );
    const ranges: Array<{ start: number; end: number }> = [];
    const payloads: Array<{ entry: ThreeMfEntry; dataOffset: number }> = [];
    let inspectedLocalHeaderBytes = 0;
    for (const entry of directory.localEntries) {
      const fixed = await this.objects.readObjectRange(
        intent.quarantineObjectKey,
        entry.localHeaderOffset,
        30,
      );
      const headerSize = threeMfLocalHeaderSize(fixed);
      if (entry.localHeaderOffset + headerSize > end.centralDirectoryOffset) {
        throw new UploadValidationError(
          "MALFORMED_ARCHIVE",
          "3MF ZIP local header overlaps its central directory",
        );
      }
      inspectedLocalHeaderBytes += headerSize;
      if (inspectedLocalHeaderBytes > MAX_3MF_LOCAL_HEADER_BYTES) {
        throw new UploadValidationError(
          "ARCHIVE_LIMIT_EXCEEDED",
          "3MF ZIP local headers exceed the inspection limit",
        );
      }
      const header =
        headerSize === fixed.byteLength
          ? fixed
          : await this.objects.readObjectRange(
              intent.quarantineObjectKey,
              entry.localHeaderOffset,
              headerSize,
            );
      const local = inspect3mfLocalEntryHeader(
        header,
        entry,
        end.centralDirectoryOffset,
      );
      let rangeEnd = local.dataEnd;
      if (local.usesDataDescriptor) {
        const descriptorBytes = Math.min(
          16,
          end.centralDirectoryOffset - rangeEnd,
        );
        if (descriptorBytes < 12) {
          throw new UploadValidationError(
            "MALFORMED_ARCHIVE",
            "3MF ZIP data descriptor overlaps its central directory",
          );
        }
        const descriptor = await this.objects.readObjectRange(
          intent.quarantineObjectKey,
          rangeEnd,
          descriptorBytes,
        );
        rangeEnd += inspect3mfDataDescriptor(descriptor, entry);
      }
      ranges.push({ start: local.start, end: rangeEnd });
      payloads.push({ entry, dataOffset: local.dataOffset });
    }
    validate3mfLocalEntryRanges(ranges);
    let expandedArchiveBytes = 0;
    for (const payload of payloads) {
      expandedArchiveBytes = await this.verify3mfEntryPayload(
        intent.quarantineObjectKey,
        payload.entry,
        payload.dataOffset,
        expandedArchiveBytes,
      );
    }
  }

  private async verify3mfEntryPayload(
    objectKey: string,
    entry: ThreeMfEntry,
    dataOffset: number,
    expandedArchiveBytes: number,
  ): Promise<number> {
    let expandedEntryBytes = 0;
    let actualCrc32 = 0;
    const compressed = Readable.from(
      this.readObjectRangeChunks(objectKey, dataOffset, entry.compressedSize),
    );
    const decoder =
      entry.compressionMethod === 8 ? createInflateRaw() : new PassThrough();

    try {
      await pipeline(compressed, decoder, async (payload) => {
        for await (const chunk of payload) {
          const bytes = objectStreamBytes(chunk);
          if (
            bytes.byteLength > MAX_3MF_ENTRY_SIZE - expandedEntryBytes ||
            bytes.byteLength > entry.expandedSize - expandedEntryBytes ||
            bytes.byteLength >
              MAX_3MF_TOTAL_SIZE - expandedArchiveBytes - expandedEntryBytes
          ) {
            throw new UploadValidationError(
              "ARCHIVE_LIMIT_EXCEEDED",
              "3MF ZIP entry exceeds actual expansion limits",
            );
          }
          expandedEntryBytes += bytes.byteLength;
          actualCrc32 = crc32(bytes, actualCrc32);
        }
      });
    } catch (error) {
      if (error instanceof UploadValidationError) throw error;
      if (isZlibError(error)) {
        throw new UploadValidationError(
          "MALFORMED_ARCHIVE",
          "3MF ZIP entry payload is invalid",
        );
      }
      throw error;
    }

    if (
      expandedEntryBytes !== entry.expandedSize ||
      actualCrc32 !== entry.crc32
    ) {
      throw new UploadValidationError(
        "MALFORMED_ARCHIVE",
        "3MF ZIP entry payload conflicts with its directory",
      );
    }
    return expandedArchiveBytes + expandedEntryBytes;
  }

  private async *readObjectRangeChunks(
    objectKey: string,
    offset: number,
    length: number,
  ): AsyncGenerator<Uint8Array> {
    let consumed = 0;
    while (consumed < length) {
      const chunkLength = Math.min(
        MAX_3MF_COMPRESSED_CHUNK_BYTES,
        length - consumed,
      );
      yield await this.objects.readObjectRange(
        objectKey,
        offset + consumed,
        chunkLength,
      );
      consumed += chunkLength;
    }
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
    if (expiresAt.getTime() - Date.now() < 1_000) {
      await this.expirePendingIntent(uploadId);
      throw new GoneException("Upload intent expired before URL signing");
    }
    let signed: Awaited<ReturnType<ObjectStorage["createUploadUrl"]>>;
    try {
      signed = await this.objects.createUploadUrl({
        objectKey: quarantineKey,
        contentType: metadata.contentType,
        contentHash: metadata.sha256,
        contentLength: metadata.sizeBytes,
        expiresAt,
      });
    } catch (error) {
      if (error instanceof ObjectStorageDeadlineError) {
        await this.expirePendingIntent(uploadId);
        throw new GoneException("Upload intent expired before URL signing");
      }
      throw error;
    }
    return {
      uploadId,
      assetId,
      accessToken: token,
      uploadUrl: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      requiredHeaders: signed.requiredHeaders,
    };
  }

  private async signDownload(
    objectKey: string,
    expiresAt: Date,
  ): Promise<SignedDownloadResponseDto> {
    try {
      const signed = await this.objects.createDownloadUrl({
        objectKey,
        expiresAt,
      });
      return {
        downloadUrl: signed.url,
        expiresAt: signed.expiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof ObjectStorageDeadlineError) {
        throw new GoneException("Stored asset expired");
      }
      throw error;
    }
  }

  private async confirmedResponse(
    intent: NonNullable<UploadIntentRecord>,
  ): Promise<ConfirmedUploadResponseDto> {
    if (!intent.confirmedAt)
      throw new ConflictException("Confirmed upload is incomplete");
    if (intent.confirmedModelFileId) {
      const model = await this.prisma.modelFile.findUnique({
        where: { id: intent.confirmedModelFileId },
        select: { uploadedAt: true, sourceDeleteAfter: true },
      });
      if (!model) throw new ConflictException("Confirmed upload is incomplete");
      return {
        uploadId: intent.id,
        assetId: intent.confirmedModelFileId,
        assetKind: intent.assetKind,
        uploadedAt: model.uploadedAt.toISOString(),
        deleteAfter: model.sourceDeleteAfter.toISOString(),
      };
    }
    if (intent.confirmedPhotoAssetId) {
      const photo = await this.prisma.photoAsset.findUnique({
        where: { id: intent.confirmedPhotoAssetId },
        select: { uploadedAt: true, photoDeleteAfter: true },
      });
      if (!photo) throw new ConflictException("Confirmed upload is incomplete");
      return {
        uploadId: intent.id,
        assetId: intent.confirmedPhotoAssetId,
        assetKind: intent.assetKind,
        uploadedAt: photo.uploadedAt.toISOString(),
        deleteAfter: photo.photoDeleteAfter.toISOString(),
      };
    }
    throw new ConflictException("Confirmed upload is incomplete");
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

function normalizeContentType(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().split(";", 1)[0] ?? "";
}

function objectStreamBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new UploadValidationError(
    "MALFORMED_ARCHIVE",
    "ZIP decoder returned a non-binary stream chunk",
  );
}

function isZlibError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("Z_")
  );
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

function normalizeClientAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized || "unknown";
}

function anonymousUploadSubject(
  hashKey: string,
  namespace: string,
  identity: string,
): string {
  return createHmac("sha256", hashKey)
    .update(`${namespace}\0${identity}`)
    .digest("hex");
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

function normalizedUuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function addRetention(uploadedAt: Date): Date {
  return new Date(uploadedAt.getTime() + RETENTION_DAYS * DAY_MILLISECONDS);
}

function availableDownloadDeadline(
  deletedAt: Date | null,
  hold: RetentionHold,
  deleteAfter: Date,
  configuredTtl: number,
): Date {
  if (deletedAt) throw new GoneException("Stored asset was deleted");
  const now = Date.now();
  const configuredDeadline = now + configuredTtl * 1_000;
  const deadline =
    hold === RetentionHold.NONE
      ? Math.min(configuredDeadline, deleteAfter.getTime())
      : configuredDeadline;
  if (deadline - now < 1_000) throw new GoneException("Stored asset expired");
  return new Date(deadline);
}

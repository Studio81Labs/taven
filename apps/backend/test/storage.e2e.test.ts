import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Test } from "@nestjs/testing";
import { RetentionDeletionJobStatus, RetentionHold } from "@prisma/client";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../src/modules/storage/object-storage.port";
import { RetentionService } from "../src/modules/storage/retention.service";
import {
  modelSourceObjectKey,
  photoExifObjectKey,
  photoOriginalObjectKey,
  photoThumbnailObjectKey,
  photoTransformObjectKey,
  quarantineObjectKey,
} from "../src/modules/storage/storage-keys";
import { PrismaService } from "../src/prisma/prisma.service";

const s3Config = {
  endpoint: process.env.TAVEN_S3_ENDPOINT ?? "http://127.0.0.1:9010",
  region: process.env.TAVEN_S3_REGION ?? "us-east-1",
  bucket: process.env.TAVEN_S3_BUCKET ?? "taven",
  accessKeyId: process.env.TAVEN_S3_ACCESS_KEY_ID ?? "taven",
  secretAccessKey: process.env.TAVEN_S3_SECRET_ACCESS_KEY ?? "taven-local-only",
  forcePathStyle: (process.env.TAVEN_S3_FORCE_PATH_STYLE ?? "true") === "true",
};
const uploadClientHashKey =
  process.env.TAVEN_UPLOAD_CLIENT_HASH_KEY ??
  "test-only-upload-client-hash-key-32";

describe("secure object storage and retention", () => {
  let app: INestApplication;
  let baseUrl: URL;
  let prisma: PrismaService;
  let objects: ObjectStorage;
  let retention: RetentionService;
  let s3: S3Client;
  const cleanupKeys = new Set<string>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    baseUrl = new URL(await app.getUrl());
    prisma = app.get(PrismaService);
    await prisma.anonymousUploadLimit.deleteMany();
    objects = app.get<ObjectStorage>(OBJECT_STORAGE);
    retention = app.get(RetentionService);
    s3 = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      forcePathStyle: s3Config.forcePathStyle,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
    });
  });

  afterAll(async () => {
    if (cleanupKeys.size > 0) {
      await objects.deleteObjects([...cleanupKeys]);
    }
    s3.destroy();
    await app.close();
  });

  it("uploads directly to MinIO, confirms once, isolates the capability, and downloads", async () => {
    const bytes = binaryStl();
    const created = await initiateModel(
      bytes,
      "bracket.stl",
      "STL",
      "model/stl",
    );
    expect(
      new URL(created.uploadUrl).searchParams.get("X-Amz-SignedHeaders"),
    ).toContain("content-length");
    cleanupKeys.add(modelSourceObjectKey(created.assetId));
    await putSigned(created, bytes);

    const deniedConfirmation = await apiJson(
      `storage/uploads/${created.uploadId}/confirm`,
      {
        method: "POST",
        headers: bearer(randomBytes(32).toString("base64url")),
      },
    );
    expect(deniedConfirmation.response.status).toBe(401);

    const confirmed = await apiJson<{
      assetId: string;
      uploadedAt: string;
      deleteAfter: string;
    }>(`storage/uploads/${created.uploadId}/confirm`, {
      method: "POST",
      headers: bearer(created.accessToken),
    });
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.body.assetId).toBe(created.assetId);
    const persistedModel = await prisma.modelFile.findUniqueOrThrow({
      where: { id: created.assetId },
    });
    expect(confirmed.body.uploadedAt).toBe(
      persistedModel.uploadedAt.toISOString(),
    );
    expect(confirmed.body.deleteAfter).toBe(
      persistedModel.sourceDeleteAfter.toISOString(),
    );

    const replay = await apiJson<{
      uploadedAt: string;
      deleteAfter: string;
    }>(`storage/uploads/${created.uploadId}/confirm`, {
      method: "POST",
      headers: bearer(created.accessToken),
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body).toMatchObject({
      uploadedAt: persistedModel.uploadedAt.toISOString(),
      deleteAfter: persistedModel.sourceDeleteAfter.toISOString(),
    });

    const denied = await apiJson(
      `storage/model-files/${created.assetId}/reorder-eligibility`,
      { headers: bearer(randomBytes(32).toString("base64url")) },
    );
    expect(denied.response.status).toBe(401);

    const eligibility = await apiJson<{
      eligible: boolean;
      reason: string;
      sourceAvailable: boolean;
    }>(`storage/model-files/${created.assetId}/reorder-eligibility`, {
      headers: bearer(created.accessToken),
    });
    expect(eligibility.body).toEqual({
      eligible: true,
      reason: "AVAILABLE",
      sourceAvailable: true,
    });

    const download = await apiJson<{ downloadUrl: string }>(
      `storage/model-files/${created.assetId}/download`,
      { method: "POST", headers: bearer(created.accessToken) },
    );
    expect(download.response.status).toBe(200);
    const downloaded = await fetch(download.body.downloadUrl);
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);

    const shortLivedUrl = await objects.createDownloadUrl({
      objectKey: modelSourceObjectKey(created.assetId),
      expiresAt: new Date(Date.now() + 1_500),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 1_600));
    expect((await fetch(shortLivedUrl.url)).status).toBe(403);
  });

  it("rejects non-string upload metadata with a structured bad request", async () => {
    const base = {
      originalFilename: "part.stl",
      sizeBytes: 84,
      sha256: "a".repeat(64),
    };
    const invalidContentType = await apiJson<{ code: string }>(
      "storage/uploads/model-files",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...base, format: "STL", contentType: null }),
      },
    );
    expect(invalidContentType.response.status).toBe(400);
    expect(invalidContentType.body.code).toBe("CONTENT_TYPE_MISMATCH");

    const invalidFormat = await apiJson<{ code: string }>(
      "storage/uploads/model-files",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...base,
          format: 42,
          contentType: "model/stl",
        }),
      },
    );
    expect(invalidFormat.response.status).toBe(400);
    expect(invalidFormat.body.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("rejects a stored object whose verified hash differs from the intent", async () => {
    const declared = binaryStl();
    const actual = binaryStl(1);
    const created = await initiateModel(
      declared,
      "mismatch.stl",
      "STL",
      "model/stl",
    );
    const intent = await prisma.uploadIntent.findUniqueOrThrow({
      where: { id: created.uploadId },
    });
    await putRaw(intent.quarantineObjectKey, actual, "model/stl");

    const confirmation = await apiJson(
      `storage/uploads/${created.uploadId}/confirm`,
      { method: "POST", headers: bearer(created.accessToken) },
    );
    expect(confirmation.response.status).toBe(409);
    expect(
      (
        await prisma.uploadIntent.findUniqueOrThrow({
          where: { id: created.uploadId },
        })
      ).status,
    ).toBe("REJECTED");
    expect(await objects.headObject(intent.quarantineObjectKey)).toBeNull();
  });

  it("rejects uploads without a provider-verified checksum", async () => {
    const bytes = binaryStl();
    const created = await initiateModel(
      bytes,
      "unchecked.stl",
      "STL",
      "model/stl",
    );
    const intent = await prisma.uploadIntent.findUniqueOrThrow({
      where: { id: created.uploadId },
    });
    await s3.send(
      new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: intent.quarantineObjectKey,
        Body: bytes,
        ContentType: "model/stl",
      }),
    );

    const confirmation = await apiJson(
      `storage/uploads/${created.uploadId}/confirm`,
      { method: "POST", headers: bearer(created.accessToken) },
    );
    expect(confirmation.response.status).toBe(409);
    expect(
      (
        await prisma.uploadIntent.findUniqueOrThrow({
          where: { id: created.uploadId },
        })
      ).status,
    ).toBe("REJECTED");
  });

  it("accepts a complete 3MF and rejects malformed or deceptive entries", async () => {
    const validBytes = threeMf();
    const valid = await initiateModel(
      validBytes,
      "assembly.3mf",
      "3MF",
      "model/3mf",
    );
    cleanupKeys.add(modelSourceObjectKey(valid.assetId));
    await putSigned(valid, validBytes);
    const confirmed = await apiJson(
      `storage/uploads/${valid.uploadId}/confirm`,
      { method: "POST", headers: bearer(valid.accessToken) },
    );
    expect(confirmed.response.status).toBe(200);

    const compressedBytes = compressedThreeMf();
    const compressed = await initiateModel(
      compressedBytes,
      "compressed.3mf",
      "3MF",
      "model/3mf",
    );
    cleanupKeys.add(modelSourceObjectKey(compressed.assetId));
    await putSigned(compressed, compressedBytes);
    const compressedConfirmation = await apiJson(
      `storage/uploads/${compressed.uploadId}/confirm`,
      { method: "POST", headers: bearer(compressed.accessToken) },
    );
    expect(compressedConfirmation.response.status).toBe(200);

    const malformedBytes = threeMf(false);
    const malformed = await initiateModel(
      malformedBytes,
      "central-only.3mf",
      "3MF",
      "model/3mf",
    );
    await putSigned(malformed, malformedBytes);
    const rejected = await apiJson<{ code: string }>(
      `storage/uploads/${malformed.uploadId}/confirm`,
      { method: "POST", headers: bearer(malformed.accessToken) },
    );
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.code).toBe("MALFORMED_ARCHIVE");
    expect(
      (
        await prisma.uploadIntent.findUniqueOrThrow({
          where: { id: malformed.uploadId },
        })
      ).status,
    ).toBe("REJECTED");

    const deceptiveBytes = deceptiveThreeMf();
    const deceptive = await initiateModel(
      deceptiveBytes,
      "expansion-bomb.3mf",
      "3MF",
      "model/3mf",
    );
    await putSigned(deceptive, deceptiveBytes);
    const expansionRejected = await apiJson<{ code: string }>(
      `storage/uploads/${deceptive.uploadId}/confirm`,
      { method: "POST", headers: bearer(deceptive.accessToken) },
    );
    expect(expansionRejected.response.status).toBe(409);
    expect(expansionRejected.body.code).toBe("ARCHIVE_LIMIT_EXCEEDED");
    expect(
      (
        await prisma.uploadIntent.findUniqueOrThrow({
          where: { id: deceptive.uploadId },
        })
      ).status,
    ).toBe("REJECTED");

    const corruptBytes = corruptCrcThreeMf();
    const corrupt = await initiateModel(
      corruptBytes,
      "corrupt-crc.3mf",
      "3MF",
      "model/3mf",
    );
    await putSigned(corrupt, corruptBytes);
    const corruptRejected = await apiJson<{ code: string }>(
      `storage/uploads/${corrupt.uploadId}/confirm`,
      { method: "POST", headers: bearer(corrupt.accessToken) },
    );
    expect(corruptRejected.response.status).toBe(409);
    expect(corruptRejected.body.code).toBe("MALFORMED_ARCHIVE");
  });

  it("confirms a reference photo without trusting its filename as an object key", async () => {
    const bytes = png();
    const scopeId = randomUUID();
    const quoteSessionToken = randomBytes(32).toString("base64url");
    const quoteSession = await prisma.quoteSession.create({
      data: {
        publicTokenHash: sha256(Buffer.from(quoteSessionToken)),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.quoteRequest.create({
      data: { id: scopeId, quoteSessionId: quoteSession.id },
    });
    const requestBody = JSON.stringify({
      kind: "QUOTE_REFERENCE",
      scopeKind: "QUOTE_REQUEST",
      scopeId,
      originalFilename: "reference final.png",
      contentType: "image/png",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
    const denied = await apiJson("storage/uploads/photos", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearer(randomBytes(32).toString("base64url")),
      },
      body: requestBody,
    });
    expect(denied.response.status).toBe(401);
    const initiated = await apiJson<{
      uploadId: string;
      assetId: string;
      accessToken: string;
      uploadUrl: string;
      requiredHeaders: Record<string, string>;
    }>("storage/uploads/photos", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearer(quoteSessionToken),
      },
      body: requestBody,
    });
    expect(initiated.response.status).toBe(201);
    cleanupKeys.add(photoOriginalObjectKey(initiated.body.assetId));
    await putSigned(initiated.body, bytes);
    const confirmed = await apiJson(
      `storage/uploads/${initiated.body.uploadId}/confirm`,
      {
        method: "POST",
        headers: bearer(initiated.body.accessToken),
      },
    );
    expect(confirmed.response.status).toBe(200);
    expect(
      await prisma.photoAsset.findUnique({
        where: { id: initiated.body.assetId },
      }),
    ).toMatchObject({
      scopeId,
      storageObjectKey: photoOriginalObjectKey(initiated.body.assetId),
      mediaType: "image/png",
    });
  });

  it("links an account and reads history without extending source retention", async () => {
    const bytes = binaryStl();
    const created = await initiateModel(bytes, "owned.stl", "STL", "model/stl");
    cleanupKeys.add(modelSourceObjectKey(created.assetId));
    await putSigned(created, bytes);
    await apiJson(`storage/uploads/${created.uploadId}/confirm`, {
      method: "POST",
      headers: bearer(created.accessToken),
    });
    const before = await prisma.modelFile.findUniqueOrThrow({
      where: { id: created.assetId },
    });
    const customer = await prisma.customer.create({
      data: { email: `${randomUUID()}@example.test` },
    });
    await prisma.uploadIntent.update({
      where: { id: created.uploadId },
      data: { customerId: customer.id },
    });
    await apiJson(
      `storage/model-files/${created.assetId}/reorder-eligibility`,
      {
        headers: bearer(created.accessToken),
      },
    );
    const after = await prisma.modelFile.findUniqueOrThrow({
      where: { id: created.assetId },
    });
    expect(after.sourceDeleteAfter).toEqual(before.sourceDeleteAfter);
    expect(after.retentionHold).toBe(before.retentionHold);
  });

  it("deletes expired sources and derived geometry while retaining hashes and audit metadata", async () => {
    const modelFileId = randomUUID();
    const geometryId = randomUUID();
    const sourceKey = modelSourceObjectKey(modelFileId);
    const geometryKey = `canonical/${geometryId}`;
    const bytes = binaryStl();
    await putRaw(sourceKey, bytes, "model/stl");
    await putRaw(geometryKey, bytes, "model/stl");
    const uploadedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    const deleteAfter = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    const capabilityToken = randomBytes(32).toString("base64url");
    await prisma.modelFile.create({
      data: {
        id: modelFileId,
        format: "STL",
        originalFilename: "expired.stl",
        storageObjectKey: sourceKey,
        contentHash: sha256(bytes),
        sizeBytes: BigInt(bytes.byteLength),
        uploadedAt,
        sourceDeleteAfter: deleteAfter,
        retentionHold: RetentionHold.LEGAL,
      },
    });
    await prisma.modelGeometry.create({
      data: {
        id: geometryId,
        sourceModelFileId: modelFileId,
        canonicalObjectKey: geometryKey,
        geometryHash: sha256(bytes),
        canonicalizerRevision: "storage-e2e-v1",
        volumeCubicMicrometers: 1n,
        boundsXMicrometers: 1n,
        boundsYMicrometers: 1n,
        boundsZMicrometers: 1n,
        triangleCount: 1,
      },
    });
    await prisma.uploadIntent.create({
      data: {
        assetKind: "MODEL_FILE",
        capabilityTokenHash: sha256(Buffer.from(capabilityToken)),
        originalFilename: "expired.stl",
        modelFormat: "STL",
        intendedAssetId: modelFileId,
        expectedContentType: "model/stl",
        expectedSizeBytes: BigInt(bytes.byteLength),
        expectedContentHash: sha256(bytes),
        quarantineObjectKey: quarantineObjectKey(randomUUID()),
        finalObjectKey: sourceKey,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        status: "CONFIRMED",
        confirmedModelFileId: modelFileId,
        confirmedAt: uploadedAt,
      },
    });
    await prisma.modelFile.update({
      where: { id: modelFileId },
      data: { retentionHold: RetentionHold.NONE },
    });

    expect(await retention.runOnce()).toBe(1);
    const source = await prisma.modelFile.findUniqueOrThrow({
      where: { id: modelFileId },
    });
    const geometry = await prisma.modelGeometry.findUniqueOrThrow({
      where: { id: geometryId },
    });
    expect(source.deletedAt).not.toBeNull();
    expect(source.contentHash).toBe(sha256(bytes));
    expect(geometry.deletedAt).toEqual(source.deletedAt);
    expect(geometry.geometryHash).toBe(sha256(bytes));
    expect(await objects.headObject(sourceKey)).toBeNull();
    expect(await objects.headObject(geometryKey)).toBeNull();
    const eligibility = await apiJson<{
      eligible: boolean;
      reason: string;
      sourceAvailable: boolean;
    }>(`storage/model-files/${modelFileId}/reorder-eligibility`, {
      headers: bearer(capabilityToken),
    });
    expect(eligibility.body).toEqual({
      eligible: false,
      reason: "SOURCE_DELETED",
      sourceAvailable: false,
    });
  });

  it("marks an old deadline job stale and never lets it beat an extension", async () => {
    const modelFileId = randomUUID();
    const sourceKey = modelSourceObjectKey(modelFileId);
    const bytes = binaryStl();
    await putRaw(sourceKey, bytes, "model/stl");
    cleanupKeys.add(sourceKey);
    const uploadedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    const oldDeadline = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const newDeadline = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    await prisma.modelFile.create({
      data: {
        id: modelFileId,
        format: "STL",
        originalFilename: "extended.stl",
        storageObjectKey: sourceKey,
        contentHash: sha256(bytes),
        sizeBytes: BigInt(bytes.byteLength),
        uploadedAt,
        sourceDeleteAfter: oldDeadline,
      },
    });
    await prisma.modelFile.update({
      where: { id: modelFileId },
      data: { sourceDeleteAfter: newDeadline },
    });

    expect(await retention.runOnce()).toBe(0);
    const oldJob = await prisma.retentionDeletionJob.findUniqueOrThrow({
      where: {
        assetKind_assetId_expectedDeleteAfter: {
          assetKind: "MODEL_FILE",
          assetId: modelFileId,
          expectedDeleteAfter: oldDeadline,
        },
      },
    });
    expect(oldJob.status).toBe(RetentionDeletionJobStatus.STALE);
    expect(
      (await prisma.modelFile.findUniqueOrThrow({ where: { id: modelFileId } }))
        .deletedAt,
    ).toBeNull();
    expect(await objects.headObject(sourceKey)).not.toBeNull();
  });

  it("deletes expired photo originals, thumbnails, transforms, and EXIF", async () => {
    const photoId = randomUUID();
    const scopeId = randomUUID();
    const keys = [
      photoOriginalObjectKey(photoId),
      photoThumbnailObjectKey(photoId),
      photoTransformObjectKey(photoId),
      photoExifObjectKey(photoId),
    ];
    const bytes = png();
    for (const key of keys) await putRaw(key, bytes, "image/png");
    const uploadedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    const deleteAfter = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    await prisma.photoAsset.create({
      data: {
        id: photoId,
        kind: "QUOTE_REFERENCE",
        scopeKind: "QUOTE_REQUEST",
        scopeId,
        storageObjectKey: keys[0]!,
        contentHash: sha256(bytes),
        mediaType: "image/png",
        sizeBytes: BigInt(bytes.byteLength),
        uploadedAt,
        photoDeleteAfter: deleteAfter,
        retentionHold: RetentionHold.LEGAL,
      },
    });
    await prisma.photoAsset.update({
      where: { id: photoId },
      data: { retentionHold: RetentionHold.NONE },
    });

    expect(await retention.runOnce()).toBe(1);
    const photo = await prisma.photoAsset.findUniqueOrThrow({
      where: { id: photoId },
    });
    expect(photo.deletedAt).not.toBeNull();
    expect(photo.contentHash).toBe(sha256(bytes));
    for (const key of keys) expect(await objects.headObject(key)).toBeNull();
  });

  it("deletes expired QC photos stored under the persisted QC namespace", async () => {
    const photoId = randomUUID();
    const jobId = randomUUID();
    const qcKey = `qc/${jobId}`;
    const bytes = png();
    await putRaw(qcKey, bytes, "image/png");
    cleanupKeys.add(qcKey);
    const uploadedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    const deleteAfter = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    await prisma.photoAsset.create({
      data: {
        id: photoId,
        kind: "QC",
        scopeKind: "JOB",
        scopeId: jobId,
        storageObjectKey: qcKey,
        contentHash: sha256(bytes),
        mediaType: "image/png",
        sizeBytes: BigInt(bytes.byteLength),
        uploadedAt,
        photoDeleteAfter: deleteAfter,
        retentionHold: RetentionHold.LEGAL,
      },
    });
    await prisma.photoAsset.update({
      where: { id: photoId },
      data: { retentionHold: RetentionHold.NONE },
    });

    expect(await retention.runOnce()).toBe(1);
    expect(
      (await prisma.photoAsset.findUniqueOrThrow({ where: { id: photoId } }))
        .deletedAt,
    ).not.toBeNull();
    expect(await objects.headObject(qcKey)).toBeNull();
  });

  it("deletes expired photos stored under the legacy quote-reference namespace", async () => {
    const photoId = randomUUID();
    const scopeId = randomUUID();
    const objectKey = `quote-reference/${photoId}`;
    const bytes = png();
    await putRaw(objectKey, bytes, "image/png");
    cleanupKeys.add(objectKey);
    const uploadedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    const deleteAfter = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    await prisma.photoAsset.create({
      data: {
        id: photoId,
        kind: "QUOTE_REFERENCE",
        scopeKind: "QUOTE_REQUEST",
        scopeId,
        storageObjectKey: objectKey,
        contentHash: sha256(bytes),
        mediaType: "image/png",
        sizeBytes: BigInt(bytes.byteLength),
        uploadedAt,
        photoDeleteAfter: deleteAfter,
        retentionHold: RetentionHold.LEGAL,
      },
    });
    await prisma.photoAsset.update({
      where: { id: photoId },
      data: { retentionHold: RetentionHold.NONE },
    });

    expect(await retention.runOnce()).toBe(1);
    expect(
      (await prisma.photoAsset.findUniqueOrThrow({ where: { id: photoId } }))
        .deletedAt,
    ).not.toBeNull();
    expect(await objects.headObject(objectKey)).toBeNull();
  });

  it("expires abandoned quarantine and any orphan final copy", async () => {
    const uploadId = randomUUID();
    const assetId = randomUUID();
    const quarantineKey = quarantineObjectKey(uploadId);
    const finalKey = modelSourceObjectKey(assetId);
    const bytes = binaryStl();
    await putRaw(quarantineKey, bytes, "model/stl");
    await putRaw(finalKey, bytes, "model/stl");
    const expiresAt = new Date(Date.now() - 6 * 60 * 1_000);
    await prisma.uploadIntent.create({
      data: {
        id: uploadId,
        assetKind: "MODEL_FILE",
        capabilityTokenHash: sha256(randomBytes(32)),
        originalFilename: "abandoned.stl",
        modelFormat: "STL",
        intendedAssetId: assetId,
        expectedContentType: "model/stl",
        expectedSizeBytes: BigInt(bytes.byteLength),
        expectedContentHash: sha256(bytes),
        quarantineObjectKey: quarantineKey,
        finalObjectKey: finalKey,
        expiresAt,
        createdAt: new Date(Date.now() - 10 * 60 * 1_000),
      },
    });

    expect(await retention.runOnce()).toBe(1);
    expect(
      (await prisma.uploadIntent.findUniqueOrThrow({ where: { id: uploadId } }))
        .status,
    ).toBe("EXPIRED");
    const settlementJob = await prisma.retentionDeletionJob.findUniqueOrThrow({
      where: {
        assetKind_assetId_expectedDeleteAfter: {
          assetKind: "UPLOAD_INTENT",
          assetId: uploadId,
          expectedDeleteAfter: expiresAt,
        },
      },
    });
    expect(settlementJob.status).toBe(RetentionDeletionJobStatus.PENDING);
    expect(settlementJob.uploadSettlementVerifiedAt).not.toBeNull();
    expect(settlementJob.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await objects.headObject(quarantineKey)).toBeNull();
    expect(await objects.headObject(finalKey)).toBeNull();

    // Model a PUT accepted before expiry that commits after the first worker's
    // final HEAD. The retained job must sweep that late object on its next pass.
    await putRaw(quarantineKey, bytes, "model/stl");
    await prisma.retentionDeletionJob.update({
      where: { id: settlementJob.id },
      data: { availableAt: new Date() },
    });
    expect(await retention.runOnce()).toBe(1);
    expect(
      await prisma.uploadIntent.findUnique({ where: { id: uploadId } }),
    ).toBeNull();
    expect(
      await prisma.retentionDeletionJob.findUnique({
        where: {
          assetKind_assetId_expectedDeleteAfter: {
            assetKind: "UPLOAD_INTENT",
            assetId: uploadId,
            expectedDeleteAfter: expiresAt,
          },
        },
      }),
    ).toBeNull();
    expect(await objects.headObject(quarantineKey)).toBeNull();
  });

  it("keeps an expired signed upload in quarantine through its settlement grace", async () => {
    const uploadId = randomUUID();
    const assetId = randomUUID();
    const quarantineKey = quarantineObjectKey(uploadId);
    const finalKey = modelSourceObjectKey(assetId);
    const bytes = binaryStl();
    await putRaw(quarantineKey, bytes, "model/stl");
    cleanupKeys.add(quarantineKey);
    const expiresAt = new Date(Date.now() - 1_000);
    await prisma.uploadIntent.create({
      data: {
        id: uploadId,
        assetKind: "MODEL_FILE",
        capabilityTokenHash: sha256(randomBytes(32)),
        originalFilename: "settling.stl",
        modelFormat: "STL",
        intendedAssetId: assetId,
        expectedContentType: "model/stl",
        expectedSizeBytes: BigInt(bytes.byteLength),
        expectedContentHash: sha256(bytes),
        quarantineObjectKey: quarantineKey,
        finalObjectKey: finalKey,
        expiresAt,
        createdAt: new Date(Date.now() - 10_000),
      },
    });

    const job = await prisma.retentionDeletionJob.findUniqueOrThrow({
      where: {
        assetKind_assetId_expectedDeleteAfter: {
          assetKind: "UPLOAD_INTENT",
          assetId: uploadId,
          expectedDeleteAfter: expiresAt,
        },
      },
    });
    expect(job.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await retention.runOnce()).toBe(0);
    expect(await objects.headObject(quarantineKey)).not.toBeNull();
  });

  it("enforces the anonymous upload budget atomically and ignores spoofed forwarding headers", async () => {
    const subjectHash = createHmac("sha256", uploadClientHashKey)
      .update("anonymous-model-upload\0" + "127.0.0.1")
      .digest("hex");
    const previous = await prisma.anonymousUploadLimit.findUnique({
      where: { subjectHash },
    });
    const previousGlobal = await prisma.anonymousUploadLimit.findUnique({
      where: { subjectHash: "global" },
    });
    const now = new Date();
    await prisma.anonymousUploadLimit.upsert({
      where: { subjectHash },
      create: {
        subjectHash,
        windowStartedAt: now,
        windowExpiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
        issuedCount: 19,
        reservedBytes: 0n,
      },
      update: {
        windowStartedAt: now,
        windowExpiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
        issuedCount: 19,
        reservedBytes: 0n,
      },
    });

    const bytes = binaryStl();
    const request = (forwardedFor: string) =>
      apiJson<{ uploadId?: string }>("storage/uploads/model-files", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": forwardedFor,
        },
        body: JSON.stringify({
          format: "STL",
          originalFilename: "limited.stl",
          contentType: "model/stl",
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes),
        }),
      });
    const results = await Promise.all([
      request("203.0.113.44"),
      request("198.51.100.22"),
    ]);
    expect(results.map(({ response }) => response.status).sort()).toEqual([
      201, 429,
    ]);
    const createdUploadId = results.find(
      ({ response }) => response.status === 201,
    )?.body.uploadId;
    expect(createdUploadId).toBeTruthy();
    if (createdUploadId) {
      await prisma.retentionDeletionJob.deleteMany({
        where: { assetKind: "UPLOAD_INTENT", assetId: createdUploadId },
      });
      await prisma.uploadIntent.delete({ where: { id: createdUploadId } });
    }
    if (previous) {
      await prisma.anonymousUploadLimit.update({
        where: { subjectHash },
        data: {
          windowStartedAt: previous.windowStartedAt,
          windowExpiresAt: previous.windowExpiresAt,
          issuedCount: previous.issuedCount,
          reservedBytes: previous.reservedBytes,
        },
      });
    } else {
      await prisma.anonymousUploadLimit.delete({ where: { subjectHash } });
    }
    if (previousGlobal) {
      await prisma.anonymousUploadLimit.update({
        where: { subjectHash: "global" },
        data: {
          windowStartedAt: previousGlobal.windowStartedAt,
          windowExpiresAt: previousGlobal.windowExpiresAt,
          issuedCount: previousGlobal.issuedCount,
          reservedBytes: previousGlobal.reservedBytes,
        },
      });
    } else {
      await prisma.anonymousUploadLimit.delete({
        where: { subjectHash: "global" },
      });
    }
  });

  it("records a failed deletion and converges through an idempotent retry", async () => {
    const modelFileId = randomUUID();
    const geometryId = randomUUID();
    const sourceKey = modelSourceObjectKey(modelFileId);
    const geometryKey = `canonical/${geometryId}`;
    const bytes = binaryStl();
    await putRaw(sourceKey, bytes, "model/stl");
    await putRaw(geometryKey, bytes, "model/stl");
    const uploadedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    const deadline = new Date(Date.now() - 1_000);
    await prisma.modelFile.create({
      data: {
        id: modelFileId,
        format: "STL",
        originalFilename: "retry.stl",
        storageObjectKey: sourceKey,
        contentHash: sha256(bytes),
        sizeBytes: BigInt(bytes.byteLength),
        uploadedAt,
        sourceDeleteAfter: deadline,
        retentionHold: RetentionHold.LEGAL,
      },
    });
    await prisma.modelGeometry.create({
      data: {
        id: geometryId,
        sourceModelFileId: modelFileId,
        canonicalObjectKey: geometryKey,
        geometryHash: sha256(bytes),
        canonicalizerRevision: "storage-e2e-retry-v1",
        volumeCubicMicrometers: 1n,
        boundsXMicrometers: 1n,
        boundsYMicrometers: 1n,
        boundsZMicrometers: 1n,
        triangleCount: 1,
      },
    });
    await prisma.modelFile.update({
      where: { id: modelFileId },
      data: { retentionHold: RetentionHold.NONE },
    });
    let failFirstDelete = true;
    const flakyStorage: ObjectStorage = {
      createUploadUrl: (input) => objects.createUploadUrl(input),
      createDownloadUrl: (input) => objects.createDownloadUrl(input),
      headObject: (key) => objects.headObject(key),
      readObjectRange: (key, offset, length) =>
        objects.readObjectRange(key, offset, length),
      copyObject: (source, destination) =>
        objects.copyObject(source, destination),
      deleteObjects: async (keys) => {
        if (failFirstDelete) {
          failFirstDelete = false;
          await objects.deleteObjects(keys.filter((key) => key !== sourceKey));
          throw new Error("simulated partial MinIO deletion");
        }
        await objects.deleteObjects(keys);
      },
      listObjects: (input) => objects.listObjects(input),
    };
    const flakyRetention = new RetentionService(prisma, flakyStorage);

    expect(await flakyRetention.runOnce()).toBe(1);
    const failed = await prisma.retentionDeletionJob.findUniqueOrThrow({
      where: {
        assetKind_assetId_expectedDeleteAfter: {
          assetKind: "MODEL_FILE",
          assetId: modelFileId,
          expectedDeleteAfter: deadline,
        },
      },
    });
    expect(failed).toMatchObject({
      status: RetentionDeletionJobStatus.FAILED,
      attempts: 1,
      lastError: "simulated partial MinIO deletion",
    });
    expect(await objects.headObject(sourceKey)).not.toBeNull();
    expect(await objects.headObject(geometryKey)).toBeNull();
    await expect(
      prisma.modelFile.update({
        where: { id: modelFileId },
        data: { retentionHold: RetentionHold.LEGAL },
      }),
    ).rejects.toThrow();
    expect(
      (
        await prisma.modelFile.findUniqueOrThrow({
          where: { id: modelFileId },
        })
      ).retentionDeletionJobId,
    ).toBe(failed.id);
    await prisma.retentionDeletionJob.update({
      where: { id: failed.id },
      data: { availableAt: new Date() },
    });

    expect(await flakyRetention.runOnce()).toBe(1);
    const succeeded = await prisma.retentionDeletionJob.findUniqueOrThrow({
      where: { id: failed.id },
    });
    expect(succeeded).toMatchObject({
      status: RetentionDeletionJobStatus.SUCCEEDED,
      attempts: 2,
      lastError: null,
    });
    expect(await objects.headObject(sourceKey)).toBeNull();
  });

  async function initiateModel(
    bytes: Uint8Array,
    originalFilename: string,
    format: "STL" | "3MF" | "STEP",
    contentType: string,
  ): Promise<{
    uploadId: string;
    assetId: string;
    accessToken: string;
    uploadUrl: string;
    requiredHeaders: Record<string, string>;
  }> {
    const result = await apiJson<{
      uploadId: string;
      assetId: string;
      accessToken: string;
      uploadUrl: string;
      requiredHeaders: Record<string, string>;
    }>("storage/uploads/model-files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format,
        originalFilename,
        contentType,
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
      }),
    });
    expect(result.response.status).toBe(201);
    return result.body;
  }

  async function putSigned(
    upload: { uploadUrl: string; requiredHeaders: Record<string, string> },
    bytes: Uint8Array,
  ): Promise<void> {
    const response = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: upload.requiredHeaders,
      body: Buffer.from(bytes),
    });
    expect(response.status).toBe(200);
  }

  async function putRaw(
    objectKey: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await s3.send(
      new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: objectKey,
        Body: bytes,
        ContentType: contentType,
        ChecksumSHA256: Buffer.from(sha256(bytes), "hex").toString("base64"),
      }),
    );
  }

  async function apiJson<T = unknown>(
    path: string,
    init?: RequestInit,
  ): Promise<{ response: Response; body: T }> {
    const response = await fetch(new URL(path, baseUrl), init);
    const body = (await response.json()) as T;
    return { response, body };
  }
});

function binaryStl(triangles = 0): Uint8Array {
  const bytes = new Uint8Array(84 + triangles * 50);
  new DataView(bytes.buffer).setUint32(80, triangles, true);
  return bytes;
}

function png(): Uint8Array {
  return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
}

function threeMf(withLocalEntries = true): Uint8Array {
  const names = ["[Content_Types].xml", "3D/3dmodel.model"];
  const localEntries = names.map((name) => zipLocalEntry(name));
  const localBytes = withLocalEntries
    ? concatBytes(...localEntries)
    : new Uint8Array();
  let localOffset = 0;
  const directory = concatBytes(
    ...names.map((name, index) => {
      const entry = zipCentralEntry(name, localOffset);
      localOffset += localEntries[index]?.byteLength ?? 0;
      return entry;
    }),
  );
  return concatBytes(
    localBytes,
    directory,
    zipEndRecord(names.length, directory.byteLength, localBytes.byteLength),
  );
}

function deceptiveThreeMf(): Uint8Array {
  const expanded = new Uint8Array(1024 * 1024);
  const compressed = new Uint8Array(deflateRawSync(expanded));
  const declaredExpandedSize = 8;
  return payloadThreeMf([
    {
      compressed,
      compressionMethod: 8,
      expandedSize: declaredExpandedSize,
      crc: crc32(expanded.subarray(0, declaredExpandedSize)),
    },
    EMPTY_ZIP_ENTRY,
  ]);
}

function compressedThreeMf(): Uint8Array {
  const contents = [
    new TextEncoder().encode("<Types/>"),
    new TextEncoder().encode("<model/>"),
  ];
  return payloadThreeMf(
    contents.map((expanded) => ({
      compressed: new Uint8Array(deflateRawSync(expanded)),
      compressionMethod: 8,
      expandedSize: expanded.byteLength,
      crc: crc32(expanded),
    })),
  );
}

function corruptCrcThreeMf(): Uint8Array {
  const expanded = new TextEncoder().encode("<Types/>");
  return payloadThreeMf([
    {
      compressed: new Uint8Array(deflateRawSync(expanded)),
      compressionMethod: 8,
      expandedSize: expanded.byteLength,
      crc: (crc32(expanded) + 1) >>> 0,
    },
    EMPTY_ZIP_ENTRY,
  ]);
}

function payloadThreeMf(payloads: readonly ZipEntryPayload[]): Uint8Array {
  const names = ["[Content_Types].xml", "3D/3dmodel.model"];
  const contentTypes = payloads[0] ?? EMPTY_ZIP_ENTRY;
  const model = payloads[1] ?? EMPTY_ZIP_ENTRY;
  const localEntries = [
    zipLocalEntry(names[0]!, contentTypes),
    zipLocalEntry(names[1]!, model),
  ];
  const localBytes = concatBytes(...localEntries);
  const directory = concatBytes(
    zipCentralEntry(names[0]!, 0, contentTypes),
    zipCentralEntry(names[1]!, localEntries[0]!.byteLength, model),
  );
  return concatBytes(
    localBytes,
    directory,
    zipEndRecord(names.length, directory.byteLength, localBytes.byteLength),
  );
}

interface ZipEntryPayload {
  compressed: Uint8Array;
  compressionMethod: number;
  expandedSize: number;
  crc: number;
}

const EMPTY_ZIP_ENTRY: ZipEntryPayload = {
  compressed: new Uint8Array(),
  compressionMethod: 0,
  expandedSize: 0,
  crc: 0,
};

function zipLocalEntry(
  name: string,
  payload: ZipEntryPayload = EMPTY_ZIP_ENTRY,
): Uint8Array {
  const encoded = new TextEncoder().encode(name);
  const entry = new Uint8Array(
    30 + encoded.byteLength + payload.compressed.byteLength,
  );
  const view = new DataView(entry.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(8, payload.compressionMethod, true);
  view.setUint32(14, payload.crc, true);
  view.setUint32(18, payload.compressed.byteLength, true);
  view.setUint32(22, payload.expandedSize, true);
  view.setUint16(26, encoded.byteLength, true);
  entry.set(encoded, 30);
  entry.set(payload.compressed, 30 + encoded.byteLength);
  return entry;
}

function zipCentralEntry(
  name: string,
  localOffset: number,
  payload: ZipEntryPayload = EMPTY_ZIP_ENTRY,
): Uint8Array {
  const encoded = new TextEncoder().encode(name);
  const entry = new Uint8Array(46 + encoded.byteLength);
  const view = new DataView(entry.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(10, payload.compressionMethod, true);
  view.setUint32(16, payload.crc, true);
  view.setUint32(20, payload.compressed.byteLength, true);
  view.setUint32(24, payload.expandedSize, true);
  view.setUint16(28, encoded.byteLength, true);
  view.setUint32(42, localOffset, true);
  entry.set(encoded, 46);
  return entry;
}

function zipEndRecord(
  entries: number,
  directorySize: number,
  directoryOffset: number,
): Uint8Array {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries, true);
  view.setUint16(10, entries, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, directoryOffset, true);
  return record;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

import { createHash } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  ImmutableObjectConflictError,
  ObjectStorageDeadlineError,
  type ImmutableObjectWrite,
  type ObjectStorage,
  type ObjectStorageDownloadRequest,
  type ObjectStorageListPage,
  type ObjectStorageListRequest,
  type ObjectStorageUploadRequest,
  type SignedObjectUrl,
  type StoredObjectMetadata,
} from "./object-storage.port";
import type { ObjectStorageConfig } from "./storage.config";
import { assertStorageObjectKey } from "./storage-keys";

const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DELETE_BATCH_SIZE = 1_000;

function base64ChecksumFromHex(contentHash: string): string {
  if (!SHA_256_HEX_PATTERN.test(contentHash)) {
    throw new Error(
      "contentHash must be a lowercase SHA-256 hexadecimal digest",
    );
  }
  return Buffer.from(contentHash, "hex").toString("base64");
}

function hexChecksumFromBase64(checksum: string | undefined): string | null {
  if (!checksum) return null;
  const bytes = Buffer.from(checksum, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== checksum) {
    throw new Error("object storage returned an invalid SHA-256 checksum");
  }
  return bytes.toString("hex");
}

function copySource(bucket: string, objectKey: string): string {
  return `${bucket}/${objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function signingWindow(expiresAt: Date): {
  signingDate: Date;
  expiresIn: number;
  signedExpiresAt: Date;
} {
  const deadline = expiresAt.getTime();
  if (!Number.isFinite(deadline)) {
    throw new Error("signed object URL deadline must be a valid date");
  }
  const signingDate = new Date();
  const expiresIn = Math.floor((deadline - signingDate.getTime()) / 1_000);
  if (expiresIn < 1) {
    throw new ObjectStorageDeadlineError();
  }
  return {
    signingDate,
    expiresIn,
    signedExpiresAt: new Date(signingDate.getTime() + expiresIn * 1_000),
  };
}

/** Provider-neutral adapter for the supported S3-compatible implementations. */
export class S3ObjectStorageAdapter implements ObjectStorage {
  private readonly client: S3Client;
  private readonly signingClient: S3Client;

  constructor(
    private readonly config: ObjectStorageConfig,
    client?: S3Client,
    signingClient?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
    this.signingClient =
      signingClient ??
      (config.publicEndpoint === config.endpoint
        ? this.client
        : new S3Client({
            region: config.region,
            endpoint: config.publicEndpoint,
            forcePathStyle: config.forcePathStyle,
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }));
  }

  async putImmutableObject(input: ImmutableObjectWrite): Promise<void> {
    assertStorageObjectKey(input.objectKey);
    if (input.bytes.byteLength < 1) {
      throw new Error("immutable object bytes must not be empty");
    }
    const actualHash = createHash("sha256").update(input.bytes).digest("hex");
    if (actualHash !== input.contentHash) {
      throw new Error("immutable object bytes do not match contentHash");
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: input.objectKey,
          Body: input.bytes,
          ContentType: input.contentType,
          ContentLength: input.bytes.byteLength,
          ChecksumAlgorithm: "SHA256",
          ChecksumSHA256: base64ChecksumFromHex(input.contentHash),
          IfNoneMatch: "*",
        }),
      );
      return;
    } catch (error) {
      if (!isPreconditionConflict(error)) throw error;
    }

    const existing = await this.headObject(input.objectKey);
    if (
      !existing ||
      existing.contentType !== input.contentType ||
      existing.contentLength !== input.bytes.byteLength
    ) {
      throw new ImmutableObjectConflictError();
    }
    const existingHash =
      existing.contentHash ??
      createHash("sha256")
        .update(
          await this.readObjectRange(
            input.objectKey,
            0,
            existing.contentLength,
          ),
        )
        .digest("hex");
    if (existingHash !== input.contentHash) {
      throw new ImmutableObjectConflictError();
    }
  }

  async createUploadUrl(
    input: ObjectStorageUploadRequest,
  ): Promise<SignedObjectUrl> {
    assertStorageObjectKey(input.objectKey);
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
      throw new Error("upload content length must be a positive safe integer");
    }
    const { signingDate, expiresIn, signedExpiresAt } = signingWindow(
      input.expiresAt,
    );
    const checksum = base64ChecksumFromHex(input.contentHash);
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.objectKey,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
      ChecksumAlgorithm: "SHA256",
      ChecksumSHA256: checksum,
    });
    const url = await getSignedUrl(this.signingClient, command, {
      expiresIn,
      signingDate,
      unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
    });

    return {
      url,
      method: "PUT",
      requiredHeaders: {
        "content-type": input.contentType,
        "content-length": String(input.contentLength),
        "x-amz-checksum-sha256": checksum,
      },
      expiresAt: signedExpiresAt,
    };
  }

  async createDownloadUrl(
    input: ObjectStorageDownloadRequest,
  ): Promise<SignedObjectUrl> {
    assertStorageObjectKey(input.objectKey);
    const { signingDate, expiresIn, signedExpiresAt } = signingWindow(
      input.expiresAt,
    );
    const url = await getSignedUrl(
      this.signingClient,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: input.objectKey,
      }),
      { expiresIn, signingDate },
    );

    return {
      url,
      method: "GET",
      requiredHeaders: {},
      expiresAt: signedExpiresAt,
    };
  }

  async headObject(objectKey: string): Promise<StoredObjectMetadata | null> {
    assertStorageObjectKey(objectKey);
    try {
      const object = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: objectKey,
          ChecksumMode: "ENABLED",
        }),
      );
      if (
        object.ContentType === undefined ||
        object.ContentLength === undefined ||
        object.ContentLength < 0
      ) {
        throw new Error("object storage returned incomplete object metadata");
      }
      return {
        contentType: object.ContentType,
        contentLength: object.ContentLength,
        contentHash: hexChecksumFromBase64(object.ChecksumSHA256),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async readObjectRange(
    objectKey: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    assertStorageObjectKey(objectKey);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1
    ) {
      throw new Error("object range must use a non-negative offset and length");
    }

    const object = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
        Range: `bytes=${offset}-${offset + length - 1}`,
      }),
    );
    if (object.ContentLength !== undefined && object.ContentLength > length) {
      abortBody(object.Body);
      throw new Error(
        "object storage returned more than the requested byte range",
      );
    }
    if (!object.Body || !(Symbol.asyncIterator in object.Body)) {
      throw new Error("object storage returned a non-streaming object body");
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
        const bytes = asBytes(chunk);
        if (bytes.byteLength > length - totalBytes) {
          throw new Error(
            "object storage returned more than the requested byte range",
          );
        }
        totalBytes += bytes.byteLength;
        chunks.push(bytes);
      }
    } catch (error) {
      abortBody(object.Body);
      throw error;
    }
    if (totalBytes !== length) {
      throw new Error("object storage returned an incomplete byte range");
    }

    const result = new Uint8Array(totalBytes);
    let writeOffset = 0;
    for (const chunk of chunks) {
      result.set(chunk, writeOffset);
      writeOffset += chunk.byteLength;
    }
    return result;
  }

  async copyObject(
    sourceObjectKey: string,
    destinationObjectKey: string,
  ): Promise<void> {
    assertStorageObjectKey(sourceObjectKey);
    assertStorageObjectKey(destinationObjectKey);
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.config.bucket,
        Key: destinationObjectKey,
        CopySource: copySource(this.config.bucket, sourceObjectKey),
        MetadataDirective: "COPY",
      }),
    );
  }

  async deleteObjects(objectKeys: readonly string[]): Promise<void> {
    for (const objectKey of objectKeys) assertStorageObjectKey(objectKey);
    for (
      let offset = 0;
      offset < objectKeys.length;
      offset += MAX_DELETE_BATCH_SIZE
    ) {
      const batch = objectKeys.slice(offset, offset + MAX_DELETE_BATCH_SIZE);
      if (batch.length === 0) continue;
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const failures = (result.Errors ?? []).filter(
        (error) => error.Code !== "NoSuchKey",
      );
      if (failures.length > 0) {
        throw new Error(
          `object storage failed to delete ${failures
            .map(
              (error) =>
                `${error.Key ?? "unknown"} (${error.Code ?? "unknown"}${
                  error.Message ? `: ${error.Message}` : ""
                })`,
            )
            .join(", ")}`,
        );
      }
    }
  }

  async listObjects(
    input: ObjectStorageListRequest,
  ): Promise<ObjectStorageListPage> {
    if (!/^[a-z0-9][a-z0-9-]*\/$/.test(input.prefix)) {
      throw new Error(
        "object storage list prefix must be a generated namespace",
      );
    }
    if (input.startAfter) {
      assertStorageObjectKey(input.startAfter);
      if (!input.startAfter.startsWith(input.prefix)) {
        throw new Error("object storage cursor must belong to its prefix");
      }
    }
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000
    ) {
      throw new Error("object storage list limit must be 1 through 1000");
    }
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: input.prefix,
        StartAfter: input.startAfter,
        MaxKeys: input.limit,
      }),
    );
    return {
      objects: (result.Contents ?? []).map((object) => {
        if (!object.Key || !object.LastModified) {
          throw new Error("object storage returned an incomplete list entry");
        }
        assertStorageObjectKey(object.Key);
        if (!object.Key.startsWith(input.prefix)) {
          throw new Error("object storage returned a key outside its prefix");
        }
        return { objectKey: object.Key, lastModified: object.LastModified };
      }),
      isTruncated: result.IsTruncated === true,
    };
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const metadata = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    metadata.name === "NotFound" ||
    metadata.name === "NoSuchKey" ||
    metadata.$metadata?.httpStatusCode === 404
  );
}

function isPreconditionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const metadata = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    metadata.name === "PreconditionFailed" ||
    metadata.name === "ConditionalRequestConflict" ||
    metadata.$metadata?.httpStatusCode === 409 ||
    metadata.$metadata?.httpStatusCode === 412
  );
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error("object storage returned a non-binary stream chunk");
}

function abortBody(body: unknown): void {
  if (
    body &&
    typeof body === "object" &&
    "destroy" in body &&
    typeof body.destroy === "function"
  ) {
    body.destroy();
  }
}

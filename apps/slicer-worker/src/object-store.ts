import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SlicingWorkerError } from "./failures.js";
import type { WorkerConfig } from "./config.js";

const SAFE_KEY =
  /^(?:models|geometries|reference-slices|slice-metrics|gcode|slicer-revisions)\/[a-z0-9][a-z0-9:-]*(?:\/[a-z0-9][a-z0-9._:-]*)*$/;

export type StoredBytes = {
  bytes: Uint8Array;
  sha256: string;
  immutableInputFingerprintSha256?: string;
  metadataContentSha256?: string;
};

export interface WorkerObjectStore {
  read(
    objectKey: string,
    maximumBytes: number,
    expectedSha256?: string,
  ): Promise<StoredBytes | null>;
  write(
    objectKey: string,
    bytes: Uint8Array,
    contentType: string,
    immutableInputFingerprintSha256?: string,
  ): Promise<{ sha256: string; cacheHit: boolean }>;
  delete(objectKey: string): Promise<void>;
}

function assertKey(objectKey: string): void {
  if (
    !SAFE_KEY.test(objectKey) ||
    objectKey.includes("..") ||
    objectKey.includes("\\")
  ) {
    throw new SlicingWorkerError(
      "deterministic_invalid",
      "INVALID_MODEL",
      "Object key is outside the worker namespaces",
    );
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class S3WorkerObjectStore implements WorkerObjectStore {
  private readonly client: S3Client;

  constructor(private readonly config: WorkerConfig["storage"]) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async read(
    objectKey: string,
    maximumBytes: number,
    expectedSha256?: string,
  ): Promise<StoredBytes | null> {
    assertKey(objectKey);
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: objectKey,
          ChecksumMode: "ENABLED",
        }),
      );
      if (!response.Body || !(Symbol.asyncIterator in response.Body)) {
        throw new Error("object response is not streamable");
      }
      if (
        response.ContentLength !== undefined &&
        response.ContentLength > maximumBytes
      ) {
        abortBody(response.Body);
        throw new SlicingWorkerError(
          "deterministic_invalid",
          "RESOURCE_LIMIT_EXCEEDED",
          "Stored object exceeds the configured byte limit",
        );
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const value of response.Body as AsyncIterable<Uint8Array>) {
        const chunk =
          value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > maximumBytes) {
          abortBody(response.Body);
          throw new SlicingWorkerError(
            "deterministic_invalid",
            "RESOURCE_LIMIT_EXCEEDED",
            "Stored object exceeds the configured byte limit",
          );
        }
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const digest = sha256(bytes);
      if (expectedSha256 !== undefined && digest !== expectedSha256) {
        throw new SlicingWorkerError(
          "deterministic_invalid",
          "INVALID_MODEL",
          "Stored object checksum does not match its immutable identity",
        );
      }
      return {
        bytes,
        sha256: digest,
        ...(response.Metadata?.["taven-input-fingerprint-sha256"]
          ? {
              immutableInputFingerprintSha256:
                response.Metadata["taven-input-fingerprint-sha256"],
            }
          : {}),
        ...(response.Metadata?.["taven-content-sha256"]
          ? {
              metadataContentSha256: response.Metadata["taven-content-sha256"],
            }
          : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      if (error instanceof SlicingWorkerError) throw error;
      throw new SlicingWorkerError(
        "retryable_infrastructure",
        "OBJECT_STORE_UNAVAILABLE",
        "Object storage read failed",
        5_000,
      );
    }
  }

  async write(
    objectKey: string,
    bytes: Uint8Array,
    contentType: string,
    immutableInputFingerprintSha256?: string,
  ): Promise<{ sha256: string; cacheHit: boolean }> {
    assertKey(objectKey);
    const digest = sha256(bytes);
    try {
      const existing = await this.read(objectKey, bytes.byteLength);
      if (existing) {
        if (
          immutableInputFingerprintSha256 !== undefined &&
          (existing.immutableInputFingerprintSha256 !==
            immutableInputFingerprintSha256 ||
            existing.metadataContentSha256 !== existing.sha256)
        ) {
          throw new SlicingWorkerError(
            "deterministic_invalid",
            "INVALID_MODEL",
            "Immutable object key does not match its identity or content digest",
          );
        }
        if (
          immutableInputFingerprintSha256 === undefined &&
          existing.sha256 !== digest
        ) {
          throw new SlicingWorkerError(
            "deterministic_invalid",
            "INVALID_MODEL",
            "Immutable object key already contains different bytes or identity",
          );
        }
        return { sha256: existing.sha256, cacheHit: true };
      }
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: objectKey,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: contentType,
          ...(immutableInputFingerprintSha256 === undefined
            ? {}
            : {
                Metadata: {
                  "taven-input-fingerprint-sha256":
                    immutableInputFingerprintSha256,
                  "taven-content-sha256": digest,
                },
              }),
          ChecksumAlgorithm: "SHA256",
          ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
          IfNoneMatch: "*",
        }),
      );
      return { sha256: digest, cacheHit: false };
    } catch (error) {
      if (error instanceof SlicingWorkerError) throw error;
      if (isPreconditionFailed(error)) {
        const winner = await this.read(objectKey, bytes.byteLength);
        if (
          winner &&
          (immutableInputFingerprintSha256 === undefined
            ? winner.sha256 === digest
            : winner.immutableInputFingerprintSha256 ===
                immutableInputFingerprintSha256 &&
              winner.metadataContentSha256 === winner.sha256)
        ) {
          return { sha256: winner.sha256, cacheHit: true };
        }
      }
      throw new SlicingWorkerError(
        "retryable_infrastructure",
        "OBJECT_STORE_UNAVAILABLE",
        "Object storage write failed",
        5_000,
      );
    }
  }

  async delete(objectKey: string): Promise<void> {
    assertKey(objectKey);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
      );
    } catch {
      throw new SlicingWorkerError(
        "retryable_infrastructure",
        "OBJECT_STORE_UNAVAILABLE",
        "Object storage cleanup failed",
        5_000,
      );
    }
  }
}

function isNotFound(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.name === "NoSuchKey" ||
    candidate?.name === "NotFound" ||
    candidate?.$metadata?.httpStatusCode === 404
  );
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

function isPreconditionFailed(error: unknown): boolean {
  return (
    (error as { name?: string })?.name === "PreconditionFailed" ||
    (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode === 412
  );
}

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { S3WorkerObjectStore, sha256 } from "./object-store.js";

const enabled = process.env.TAVEN_STORAGE_CONTRACT_INTEGRATION === "1";
const storage = {
  endpoint: process.env.TAVEN_S3_ENDPOINT ?? "http://127.0.0.1:9010",
  region: process.env.TAVEN_S3_REGION ?? "us-east-1",
  bucket: process.env.TAVEN_S3_BUCKET ?? "taven",
  accessKeyId: process.env.TAVEN_S3_ACCESS_KEY_ID ?? "taven",
  secretAccessKey: process.env.TAVEN_S3_SECRET_ACCESS_KEY ?? "taven-local-only",
  forcePathStyle: (process.env.TAVEN_S3_FORCE_PATH_STYLE ?? "true") === "true",
};
const cleanupKeys = new Set<string>();

describe.skipIf(!enabled)("connected worker object-store immutability", () => {
  afterAll(async () => {
    const store = new S3WorkerObjectStore(storage);
    for (const key of cleanupKeys) await store.delete(key);
  });

  it("returns one stable winner to independent simultaneous fingerprint-cache writers and a delayed retry", async () => {
    let initialReads = 0;
    let releaseReads!: () => void;
    const bothReadAbsence = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    class CoordinatedStore extends S3WorkerObjectStore {
      private firstRead = true;

      override async read(
        ...args: Parameters<S3WorkerObjectStore["read"]>
      ): ReturnType<S3WorkerObjectStore["read"]> {
        const result = await super.read(...args);
        if (this.firstRead) {
          this.firstRead = false;
          expect(result).toBeNull();
          if (++initialReads === 2) releaseReads();
          await bothReadAbsence;
        }
        return result;
      }
    }
    const first = new CoordinatedStore(storage);
    const second = new CoordinatedStore(storage);
    const fingerprint = sha256(
      new TextEncoder().encode(`input-${randomUUID()}`),
    );
    const objectKey = `gcode/${randomUUID()}/output.3mf`;
    cleanupKeys.add(objectKey);
    const bytesA = new TextEncoder().encode(`artifact-a-${randomUUID()}`);
    const bytesB = new TextEncoder().encode(`artifact-b-${randomUUID()}`);
    expect(bytesA.byteLength).toBe(bytesB.byteLength);

    const [resultA, resultB] = await Promise.all([
      first.write(objectKey, bytesA, "application/octet-stream", fingerprint),
      second.write(objectKey, bytesB, "application/octet-stream", fingerprint),
    ]);
    const persisted = await first.read(objectKey, bytesA.byteLength);
    expect(persisted).not.toBeNull();
    expect([sha256(bytesA), sha256(bytesB)]).toContain(persisted!.sha256);
    expect(persisted!.metadataContentSha256).toBe(persisted!.sha256);
    expect(persisted!.immutableInputFingerprintSha256).toBe(fingerprint);
    expect(resultA.sha256).toBe(persisted!.sha256);
    expect(resultB.sha256).toBe(persisted!.sha256);
    expect([resultA.cacheHit, resultB.cacheHit].sort()).toEqual([false, true]);
    const losingBytes = persisted!.sha256 === sha256(bytesA) ? bytesB : bytesA;
    await expect(
      second.write(
        objectKey,
        losingBytes,
        "application/octet-stream",
        fingerprint,
      ),
    ).resolves.toEqual({
      sha256: persisted!.sha256,
      cacheHit: true,
    });
    expect(await first.read(objectKey, bytesA.byteLength)).toEqual(persisted);
  });

  it("accepts simultaneous identical worker writes without changing the artifact", async () => {
    const first = new S3WorkerObjectStore(storage);
    const second = new S3WorkerObjectStore(storage);
    const bytes = new TextEncoder().encode(`artifact-${randomUUID()}`);
    const fingerprint = sha256(
      new TextEncoder().encode(`input-${randomUUID()}`),
    );
    const objectKey = `reference-slices/${fingerprint}/artifact.3mf`;
    cleanupKeys.add(objectKey);
    const results = await Promise.all([
      first.write(objectKey, bytes, "application/octet-stream", fingerprint),
      second.write(objectKey, bytes, "application/octet-stream", fingerprint),
    ]);
    expect(results.map((result) => result.sha256)).toEqual([
      sha256(bytes),
      sha256(bytes),
    ]);
    expect(await first.read(objectKey, bytes.byteLength)).toMatchObject({
      bytes,
      sha256: sha256(bytes),
      metadataContentSha256: sha256(bytes),
      immutableInputFingerprintSha256: fingerprint,
    });
  });
});

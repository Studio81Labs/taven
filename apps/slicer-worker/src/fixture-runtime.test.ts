import {
  geometrySelectionSha256,
  slicingInputFingerprint,
} from "@taven/slicer-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  closeFixtureWorkers,
  createFixtureWorkers,
} from "./fixture-runtime.js";

const ids = {
  job: "11111111-1111-4111-8111-111111111111",
  correlation: "22222222-2222-4222-8222-222222222222",
  model: "33333333-3333-4333-8333-333333333333",
  geometry: "44444444-4444-4444-8444-444444444444",
  profile: "55555555-5555-4555-8555-555555555555",
  config: "66666666-6666-4666-8666-666666666666",
} as const;

const legacyJob = {
  contractVersion: 1 as const,
  jobId: ids.job,
  inputObjectKey: "fixture/input.stl",
  inputSha256: "a".repeat(64),
  profileVersion: "fixture-v1",
  profileSha256: "b".repeat(64),
};

const referenceInput = {
  geometry: {
    sourceModelFileId: ids.model,
    sourceContentSha256: "a".repeat(64),
    modelGeometryId: ids.geometry,
    canonicalObjectKey: `geometries/${ids.geometry}/canonical`,
    geometrySha256: "b".repeat(64),
    bodyIds: ["body-0001"],
    selectionSha256: geometrySelectionSha256(["body-0001"]),
  },
  referenceProfile: {
    revisionId: ids.profile,
    contentSha256: "d".repeat(64),
    slicerEngine: "fixture",
    slicerVersion: "0.0.0",
  },
  printConfig: {
    revisionId: ids.config,
    contentSha256: "e".repeat(64),
  },
  partsPerPlate: 1,
};
const referenceFingerprint = slicingInputFingerprint(
  "reference_slice",
  referenceInput,
);
const referenceJob = {
  contractVersion: 2 as const,
  kind: "reference_slice" as const,
  jobId: ids.job,
  correlationId: ids.correlation,
  inputFingerprintSha256: referenceFingerprint,
  idempotencyKey: `slicer:v2:reference_slice:${ids.job}:${referenceFingerprint}`,
  attempt: 1,
  input: referenceInput,
};

describe("fixture worker runtime", () => {
  it("registers isolated v1 and v2 processors on their exact queues", () => {
    const registrations: Array<{
      queueName: string;
      processor: (input: unknown) => unknown;
    }> = [];
    createFixtureWorkers((queueName, processor) => {
      registrations.push({ queueName, processor });
      return { close: vi.fn(async () => undefined) };
    });

    expect(registrations.map(({ queueName }) => queueName)).toEqual([
      "taven-slicing-v1",
      "taven-slicing-v2",
    ]);
    expect(registrations[0]!.processor(legacyJob)).toMatchObject({
      contractVersion: 1,
      jobId: ids.job,
    });
    expect(registrations[1]!.processor(referenceJob)).toMatchObject({
      contractVersion: 2,
      kind: "reference_slice",
      jobId: ids.job,
    });
    expect(() => registrations[0]!.processor(referenceJob)).toThrow();
    expect(() => registrations[1]!.processor(legacyJob)).toThrow();
  });

  it("closes every queue consumer during shutdown", async () => {
    const closeV1 = vi.fn(async () => undefined);
    const closeV2 = vi.fn(async () => undefined);

    await closeFixtureWorkers([{ close: closeV1 }, { close: closeV2 }]);

    expect(closeV1).toHaveBeenCalledOnce();
    expect(closeV2).toHaveBeenCalledOnce();
  });
});

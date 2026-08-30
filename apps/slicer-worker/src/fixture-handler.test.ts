import { describe, expect, it } from "vitest";
import { slicingInputFingerprint } from "@taven/slicer-contracts";
import { runFixtureSlicingJob } from "./fixture-handler.js";

const fixtureInput = {
  geometry: {
    sourceModelFileId: "11111111-1111-4111-8111-111111111111",
    sourceContentSha256: "b".repeat(64),
    modelGeometryId: "22222222-2222-4222-8222-222222222222",
    canonicalObjectKey:
      "geometries/22222222-2222-4222-8222-222222222222/canonical",
    geometrySha256: "c".repeat(64),
    bodyIds: ["body-0001"],
    selectionSha256: "d".repeat(64),
  },
  referenceProfile: {
    revisionId: "33333333-3333-4333-8333-333333333333",
    contentSha256: "e".repeat(64),
  },
  printConfig: {
    revisionId: "44444444-4444-4444-8444-444444444444",
    contentSha256: "f".repeat(64),
  },
  partsPerPlate: 1,
};
const inputFingerprintSha256 = slicingInputFingerprint(
  "reference_slice",
  fixtureInput,
);
const fixtureJob = {
  contractVersion: 2 as const,
  kind: "reference_slice" as const,
  jobId: "93ce90b0-3ed3-4d64-8a46-f032f31fa21d",
  correlationId: "bd80ab1d-5648-4f54-ae13-95fa2317150d",
  inputFingerprintSha256,
  idempotencyKey: `slicer:v2:reference_slice:${inputFingerprintSha256}`,
  attempt: 1,
  input: fixtureInput,
};

describe("runFixtureSlicingJob", () => {
  it("returns identical metadata for identical input and profile", () => {
    expect(runFixtureSlicingJob(fixtureJob)).toEqual(
      runFixtureSlicingJob(fixtureJob),
    );
  });

  it("exposes the fixture engine and a normalized reference result", () => {
    expect(runFixtureSlicingJob(fixtureJob).engine).toEqual({
      name: "fixture",
      version: "0.0.0",
      imageSha256: "f".repeat(64),
    });
    expect(runFixtureSlicingJob(fixtureJob)).toMatchObject({
      kind: "reference_slice",
      outcome: {
        status: "succeeded",
        metrics: { plateCount: 1 },
      },
    });
  });
});

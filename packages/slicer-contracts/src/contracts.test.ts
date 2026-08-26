import { describe, expect, it } from "vitest";
import { SlicingJobSchema } from "./contracts.js";

describe("SlicingJobSchema", () => {
  it("accepts the versioned fixture message", () => {
    expect(
      SlicingJobSchema.parse({
        contractVersion: 1,
        jobId: "93ce90b0-3ed3-4d64-8a46-f032f31fa21d",
        inputObjectKey: "fixtures/cube.stl",
        inputSha256: "a".repeat(64),
        profileVersion: "fixture-v1",
        profileSha256: "b".repeat(64),
      }),
    ).toMatchObject({ contractVersion: 1, profileVersion: "fixture-v1" });
  });

  it("rejects unknown contract versions", () => {
    expect(() => SlicingJobSchema.parse({ contractVersion: 2 })).toThrow();
  });
});

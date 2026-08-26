import { describe, expect, it } from "vitest";
import { runFixtureSlicingJob } from "./fixture-handler.js";

const fixtureJob = {
  contractVersion: 1 as const,
  jobId: "93ce90b0-3ed3-4d64-8a46-f032f31fa21d",
  inputObjectKey: "fixtures/cube.stl",
  inputSha256: "a".repeat(64),
  profileVersion: "fixture-v1",
  profileSha256: "b".repeat(64),
};

describe("runFixtureSlicingJob", () => {
  it("returns identical metadata for identical input and profile", () => {
    expect(runFixtureSlicingJob(fixtureJob)).toEqual(
      runFixtureSlicingJob(fixtureJob),
    );
  });

  it("exposes the fixture engine and profile hash", () => {
    expect(runFixtureSlicingJob(fixtureJob).engine).toEqual({
      name: "fixture",
      version: "0.0.0",
      profileSha256: "b".repeat(64),
    });
  });
});

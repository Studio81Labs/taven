import { describe, expect, it, vi } from "vitest";
import type { SlicingResult } from "@taven/slicer-contracts";
import { RetryableSlicingResultError } from "./failures.js";
import { processWithRetryableProgress } from "./retry-progress.js";

describe("retryable slicing progress", () => {
  it("stores the validated result envelope before rejecting the queue attempt", async () => {
    const result = {
      kind: "model_inspection",
      outcome: {
        status: "failed",
        failureClass: "retryable_infrastructure",
      },
    } as SlicingResult;
    const updateProgress = vi.fn().mockResolvedValue(undefined);
    const error = new RetryableSlicingResultError(result);

    await expect(
      processWithRetryableProgress(
        { job: "input" },
        2,
        updateProgress,
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
    expect(updateProgress).toHaveBeenCalledWith({
      type: "retryable-slicing-result",
      queueAttempt: 2,
      result,
    });
  });

  it("does not turn an unclassified processor failure into a terminal result", async () => {
    const updateProgress = vi.fn().mockResolvedValue(undefined);
    const error = new Error("unexpected failure");

    await expect(
      processWithRetryableProgress(undefined, 1, updateProgress, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(updateProgress).not.toHaveBeenCalled();
  });
});

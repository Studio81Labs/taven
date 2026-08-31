import type { SlicingResult } from "@taven/slicer-contracts";
import { RetryableSlicingResultError } from "./failures.js";

export type RetryableSlicingProgress = {
  type: "retryable-slicing-result";
  queueAttempt: number;
  result: SlicingResult;
};

export async function processWithRetryableProgress(
  input: unknown,
  queueAttempt: number,
  updateProgress: (progress: RetryableSlicingProgress) => Promise<unknown>,
  process: (input: unknown) => unknown,
): Promise<unknown> {
  try {
    return await process(input);
  } catch (error) {
    if (error instanceof RetryableSlicingResultError) {
      await updateProgress({
        type: "retryable-slicing-result",
        queueAttempt,
        result: error.result,
      });
    }
    throw error;
  }
}

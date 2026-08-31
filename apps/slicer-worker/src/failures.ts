import type { SlicingFailure } from "@taven/slicer-contracts";

type FailureClass = SlicingFailure["failureClass"];
type FailureCode = SlicingFailure["code"];

export class SlicingWorkerError extends Error {
  constructor(
    readonly failureClass: FailureClass,
    readonly code: FailureCode,
    message: string,
    readonly retryAfterMilliseconds: number | null = null,
  ) {
    super(safeMessage(message));
    this.name = "SlicingWorkerError";
  }
}

export function safeMessage(value: string): string {
  const safe = value
    .split("")
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159)
        ? " "
        : character;
    })
    .join("")
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/\S+|(?:^|\s)(?:\/|[a-z]:\\)\S*)/giu, "")
    .replace(
      /\b(?:authorization|bearer|password|secret|token)\b/giu,
      "credential",
    )
    .replace(/[\\/]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (safe || "Slicing operation failed").slice(0, 512);
}

export function failureOutcome(error: unknown): SlicingFailure {
  const failure =
    error instanceof SlicingWorkerError
      ? error
      : new SlicingWorkerError(
          "retryable_infrastructure",
          "ENGINE_UNAVAILABLE",
          error instanceof Error ? error.message : "Slicing engine unavailable",
        );
  if (failure.failureClass === "retryable_infrastructure") {
    return {
      status: "failed",
      failureClass: failure.failureClass,
      code: failure.code as
        | "OBJECT_STORE_UNAVAILABLE"
        | "ENGINE_UNAVAILABLE"
        | "ENGINE_TIMEOUT"
        | "TEMPORARY_CAPACITY",
      retryable: true,
      message: failure.message,
      retryAfterMilliseconds: failure.retryAfterMilliseconds,
    };
  }
  if (failure.failureClass === "unsupported_input") {
    return {
      status: "failed",
      failureClass: failure.failureClass,
      code: failure.code as
        | "UNSUPPORTED_FORMAT"
        | "UNSUPPORTED_FEATURE"
        | "PAINTED_OR_MULTIMATERIAL",
      retryable: false,
      message: failure.message,
      retryAfterMilliseconds: null,
    };
  }
  return {
    status: "failed",
    failureClass: "deterministic_invalid",
    code: failure.code as
      | "INVALID_MODEL"
      | "INVALID_GEOMETRY"
      | "INVALID_PROFILE"
      | "RESOURCE_LIMIT_EXCEEDED",
    retryable: false,
    message: failure.message,
    retryAfterMilliseconds: null,
  };
}

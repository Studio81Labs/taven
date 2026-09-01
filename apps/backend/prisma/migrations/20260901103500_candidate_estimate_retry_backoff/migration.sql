ALTER TABLE "candidate_estimate_terminal_results"
ADD COLUMN "retry_after_milliseconds" INTEGER;

ALTER TABLE "candidate_estimate_terminal_results"
ADD CONSTRAINT "candidate_estimate_terminal_results_retry_after_check"
CHECK (
    "retry_after_milliseconds" IS NULL
    OR (
        "outcome" = 'FAILED'
        AND "retry_after_milliseconds" >= 0
    )
);

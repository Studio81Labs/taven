CREATE TABLE "payment_webhook_limits" (
    "subject_hash" varchar(64) NOT NULL,
    "window_started_at" timestamptz(3) NOT NULL,
    "window_expires_at" timestamptz(3) NOT NULL,
    "issued_count" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(3) NOT NULL,
    CONSTRAINT "payment_webhook_limits_pkey" PRIMARY KEY ("subject_hash"),
    CONSTRAINT "payment_webhook_limits_nonnegative" CHECK ("issued_count" >= 0),
    CONSTRAINT "payment_webhook_limits_window" CHECK (
        "window_expires_at" > "window_started_at"
    )
);

CREATE INDEX "payment_webhook_limits_window_expires_at_idx"
    ON "payment_webhook_limits"("window_expires_at");

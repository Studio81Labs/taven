-- Preserve expired idempotency evidence while allowing the public key to begin
-- a new bounded generation after its declared replay window.
ALTER TABLE "idempotency_records"
    ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1,
    ADD CONSTRAINT "idempotency_records_generation_check"
        CHECK ("generation" > 0);

DROP INDEX "idempotency_records_namespace_idempotency_key_key";

CREATE UNIQUE INDEX "idempotency_records_namespace_key_generation_key"
    ON "idempotency_records"("namespace", "idempotency_key", "generation");

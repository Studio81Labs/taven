ALTER TABLE "audit_events"
    ADD COLUMN "operator_identity_id" uuid,
    ADD COLUMN "node_id" uuid,
    ADD COLUMN "schema_version" integer NOT NULL DEFAULT 1,
    ADD COLUMN "reason_code" varchar(100),
    ADD COLUMN "reason" text;

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_operator_identity_id_fkey"
        FOREIGN KEY ("operator_identity_id")
        REFERENCES "operator_identities"("id") ON DELETE RESTRICT,
    ADD CONSTRAINT "audit_events_node_id_fkey"
        FOREIGN KEY ("node_id")
        REFERENCES "nodes"("id") ON DELETE RESTRICT,
    ADD CONSTRAINT "audit_events_schema_version_check"
        CHECK ("schema_version" IN (1, 2)),
    ADD CONSTRAINT "audit_events_reason_check"
        CHECK (
            ("reason" IS NULL AND "reason_code" IS NULL)
            OR (
                "reason" IS NOT NULL
                AND length(btrim("reason")) BETWEEN 1 AND 1000
                AND "reason_code" IS NOT NULL
                AND "reason_code" ~ '^[A-Z][A-Z0-9_]{0,99}$'
            )
        ),
    ADD CONSTRAINT "audit_events_operator_identity_check"
        CHECK (
            "schema_version" = 1
            OR (
                "schema_version" = 2
                AND (
                    ("actor_kind" = 'OPERATOR'
                        AND "operator_identity_id" IS NOT NULL
                        AND "actor_id" IS NOT NULL
                        AND "actor_id" = "operator_identity_id")
                    OR ("actor_kind" <> 'OPERATOR' AND "operator_identity_id" IS NULL)
                )
            )
        );

ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_scope_check";
ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_scope_check" CHECK (
        "quote_request_id" IS NOT NULL
        OR "quote_id" IS NOT NULL
        OR "order_id" IS NOT NULL
        OR "payment_id" IS NOT NULL
        OR "refund_transaction_id" IS NOT NULL
        OR "node_id" IS NOT NULL
    );

CREATE INDEX "audit_events_operator_identity_created_at_id_idx"
    ON "audit_events"("operator_identity_id", "created_at", "id");
CREATE INDEX "audit_events_event_type_created_at_id_idx"
    ON "audit_events"("event_type", "created_at", "id");
CREATE INDEX "audit_events_node_created_at_id_idx"
    ON "audit_events"("node_id", "created_at", "id");

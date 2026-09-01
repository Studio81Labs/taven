CREATE TYPE "automatic_quote_risk_decision" AS ENUM ('ACKNOWLEDGED', 'DECLINED');

CREATE TABLE "automatic_quote_drafts" (
    "order_id" UUID NOT NULL,
    "selected_delivery_destination_id" UUID,
    "express_requested" BOOLEAN NOT NULL DEFAULT false,
    "configuration_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "automatic_quote_drafts_pkey" PRIMARY KEY ("order_id"),
    CONSTRAINT "automatic_quote_drafts_revision_check"
        CHECK ("configuration_revision" > 0)
);

CREATE TABLE "automatic_quote_model_files" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "model_file_id" UUID NOT NULL,
    "inspection_job_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "automatic_quote_model_files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "automatic_quote_item_drafts" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "source_model_file_id" UUID NOT NULL,
    "body_ids" TEXT[] NOT NULL,
    "selection_sha256" VARCHAR(64) NOT NULL,
    "target_model_geometry_id" UUID NOT NULL,
    "print_config_revision_id" UUID NOT NULL,
    "reference_profile_id" UUID NOT NULL,
    "material" "material" NOT NULL,
    "color" VARCHAR(100),
    "infill_preset" VARCHAR(50) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "fit_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "reference_parts_per_plate" INTEGER NOT NULL,
    "configuration_fingerprint" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "automatic_quote_item_drafts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "automatic_quote_item_drafts_values_check" CHECK (
        "ordinal" >= 0
        AND cardinality("body_ids") BETWEEN 1 AND 256
        AND "selection_sha256" ~ '^[a-f0-9]{64}$'
        AND "configuration_fingerprint" ~ '^[a-f0-9]{64}$'
        AND "infill_preset" ~ '[^[:space:]]'
        AND "quantity" BETWEEN 1 AND 1000
        AND "reference_parts_per_plate" BETWEEN 1 AND "quantity"
    )
);

CREATE TABLE "automatic_quote_risk_decisions" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "automatic_quote_item_id" UUID NOT NULL,
    "preflight_finding_id" UUID NOT NULL,
    "configuration_fingerprint" VARCHAR(64) NOT NULL,
    "acknowledgement_key" VARCHAR(128) NOT NULL,
    "decision" "automatic_quote_risk_decision" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "automatic_quote_risk_decisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "automatic_quote_risk_decisions_values_check" CHECK (
        "configuration_fingerprint" ~ '^[a-f0-9]{64}$'
        AND "acknowledgement_key" ~ '^[a-z0-9][a-z0-9._:-]*$'
    )
);

CREATE UNIQUE INDEX "automatic_quote_drafts_selected_destination_id_key"
    ON "automatic_quote_drafts"("selected_delivery_destination_id");
CREATE UNIQUE INDEX "automatic_quote_drafts_selected_destination_order_key"
    ON "automatic_quote_drafts"("selected_delivery_destination_id", "order_id");
CREATE INDEX "automatic_quote_model_files_model_file_id_idx"
    ON "automatic_quote_model_files"("model_file_id");
CREATE UNIQUE INDEX "automatic_quote_model_files_order_id_model_file_id_key"
    ON "automatic_quote_model_files"("order_id", "model_file_id");
CREATE UNIQUE INDEX "automatic_quote_model_files_order_id_inspection_job_id_key"
    ON "automatic_quote_model_files"("order_id", "inspection_job_id");
CREATE INDEX "automatic_quote_item_drafts_source_model_file_id_idx"
    ON "automatic_quote_item_drafts"("source_model_file_id");
CREATE INDEX "automatic_quote_item_drafts_target_model_geometry_id_idx"
    ON "automatic_quote_item_drafts"("target_model_geometry_id");
CREATE UNIQUE INDEX "automatic_quote_item_drafts_order_id_ordinal_key"
    ON "automatic_quote_item_drafts"("order_id", "ordinal");
CREATE UNIQUE INDEX "automatic_quote_item_drafts_order_id_configuration_fingerprint_key"
    ON "automatic_quote_item_drafts"("order_id", "configuration_fingerprint");
CREATE UNIQUE INDEX "automatic_quote_item_drafts_id_order_id_key"
    ON "automatic_quote_item_drafts"("id", "order_id");
CREATE INDEX "automatic_quote_risk_decisions_order_configuration_idx"
    ON "automatic_quote_risk_decisions"("order_id", "configuration_fingerprint");
CREATE UNIQUE INDEX "automatic_quote_risk_decisions_current_finding_key"
    ON "automatic_quote_risk_decisions"(
        "automatic_quote_item_id", "preflight_finding_id", "configuration_fingerprint"
    );

ALTER TABLE "automatic_quote_drafts"
    ADD CONSTRAINT "automatic_quote_drafts_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_quote_drafts"
    ADD CONSTRAINT "automatic_quote_drafts_selected_destination_fkey"
    FOREIGN KEY ("selected_delivery_destination_id", "order_id")
    REFERENCES "delivery_destinations"("id", "order_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_quote_model_files"
    ADD CONSTRAINT "automatic_quote_model_files_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "automatic_quote_drafts"("order_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_quote_model_files"
    ADD CONSTRAINT "automatic_quote_model_files_model_file_id_fkey"
    FOREIGN KEY ("model_file_id") REFERENCES "model_files"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_quote_item_drafts"
    ADD CONSTRAINT "automatic_quote_item_drafts_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "automatic_quote_drafts"("order_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_quote_item_drafts"
    ADD CONSTRAINT "automatic_quote_item_drafts_source_model_file_id_fkey"
    FOREIGN KEY ("source_model_file_id") REFERENCES "model_files"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_quote_item_drafts"
    ADD CONSTRAINT "automatic_quote_item_drafts_print_config_revision_id_fkey"
    FOREIGN KEY ("print_config_revision_id") REFERENCES "print_config_revisions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_quote_item_drafts"
    ADD CONSTRAINT "automatic_quote_item_drafts_reference_profile_id_fkey"
    FOREIGN KEY ("reference_profile_id") REFERENCES "reference_profiles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_quote_risk_decisions"
    ADD CONSTRAINT "automatic_quote_risk_decisions_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "automatic_quote_drafts"("order_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_quote_risk_decisions"
    ADD CONSTRAINT "automatic_quote_risk_decisions_item_order_fkey"
    FOREIGN KEY ("automatic_quote_item_id", "order_id")
    REFERENCES "automatic_quote_item_drafts"("id", "order_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_quote_risk_decisions"
    ADD CONSTRAINT "automatic_quote_risk_decisions_preflight_finding_id_fkey"
    FOREIGN KEY ("preflight_finding_id") REFERENCES "preflight_findings"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "taven_guard_automatic_quote_draft_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    scoped_order_id UUID;
BEGIN
    scoped_order_id := COALESCE(NEW."order_id", OLD."order_id");
    PERFORM "taven_lock_automatic_order_session"(scoped_order_id);

    IF EXISTS (
        SELECT 1 FROM "payments" payment
        WHERE payment."order_id" = scoped_order_id
    ) OR EXISTS (
        SELECT 1 FROM "orders" order_row
        WHERE order_row."id" = scoped_order_id
          AND order_row."accepted_order_price_binding_id" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'automatic quote input is frozen after checkout starts'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'automatic_quote_draft_checkout_lock';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "automatic_quote_drafts_write_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "automatic_quote_drafts"
FOR EACH ROW EXECUTE FUNCTION "taven_guard_automatic_quote_draft_write"();
CREATE TRIGGER "automatic_quote_model_files_write_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "automatic_quote_model_files"
FOR EACH ROW EXECUTE FUNCTION "taven_guard_automatic_quote_draft_write"();
CREATE TRIGGER "automatic_quote_item_drafts_write_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "automatic_quote_item_drafts"
FOR EACH ROW EXECUTE FUNCTION "taven_guard_automatic_quote_draft_write"();
CREATE TRIGGER "automatic_quote_risk_decisions_write_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "automatic_quote_risk_decisions"
FOR EACH ROW EXECUTE FUNCTION "taven_guard_automatic_quote_draft_write"();

CREATE OR REPLACE FUNCTION "taven_validate_automatic_quote_item_draft"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "automatic_quote_model_files" attached
        JOIN "model_files" source ON source."id" = attached."model_file_id"
        JOIN "print_config_revisions" config
          ON config."id" = NEW."print_config_revision_id"
        JOIN "reference_profiles" profile
          ON profile."id" = NEW."reference_profile_id"
        WHERE attached."order_id" = NEW."order_id"
          AND attached."model_file_id" = NEW."source_model_file_id"
          AND source."deleted_at" IS NULL
          AND profile."state" = 'ACTIVE'
          AND profile."material" = NEW."material"
          AND profile."quality" = config."quality"
    ) THEN
        RAISE EXCEPTION 'automatic quote item does not match attached source and active profiles'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'automatic_quote_item_draft_profile_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "automatic_quote_item_drafts_profile_check"
BEFORE INSERT OR UPDATE ON "automatic_quote_item_drafts"
FOR EACH ROW EXECUTE FUNCTION "taven_validate_automatic_quote_item_draft"();

CREATE OR REPLACE FUNCTION "taven_validate_automatic_quote_risk_decision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    finding_key TEXT;
    finding_severity "preflight_severity";
    current_fingerprint TEXT;
    acknowledged_count INTEGER;
BEGIN
    SELECT finding."evidence" ->> 'acknowledgementKey', finding."severity",
           item."configuration_fingerprint"
      INTO finding_key, finding_severity, current_fingerprint
    FROM "preflight_findings" finding
    JOIN "automatic_quote_item_drafts" item
      ON item."id" = NEW."automatic_quote_item_id"
     AND item."order_id" = NEW."order_id"
    WHERE finding."id" = NEW."preflight_finding_id"
      AND finding."model_file_id" = item."source_model_file_id"
      AND (finding."model_geometry_id" IS NULL
           OR finding."model_geometry_id" = item."target_model_geometry_id");

    IF finding_severity IS DISTINCT FROM 'WARNING'
       OR finding_key IS DISTINCT FROM NEW."acknowledgement_key"
       OR current_fingerprint IS DISTINCT FROM NEW."configuration_fingerprint" THEN
        RAISE EXCEPTION 'risk decision does not match a current acknowledgeable finding'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'automatic_quote_risk_decision_finding_check';
    END IF;

    IF NEW."decision" = 'ACKNOWLEDGED' THEN
        SELECT count(*) INTO acknowledged_count
        FROM "automatic_quote_risk_decisions" decision
        WHERE decision."order_id" = NEW."order_id"
          AND decision."decision" = 'ACKNOWLEDGED'
          AND decision."configuration_fingerprint" IN (
              SELECT item."configuration_fingerprint"
              FROM "automatic_quote_item_drafts" item
              WHERE item."order_id" = NEW."order_id"
          )
          AND decision."id" <> NEW."id";
        IF acknowledged_count >= 3 THEN
            RAISE EXCEPTION 'automatic quote accepts at most three current risk acknowledgements'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'automatic_quote_risk_acknowledgement_limit';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "automatic_quote_risk_decisions_finding_check"
BEFORE INSERT OR UPDATE ON "automatic_quote_risk_decisions"
FOR EACH ROW EXECUTE FUNCTION "taven_validate_automatic_quote_risk_decision"();

-- The automatic quote service consumes only this server-owned, versioned
-- configuration. Provider fees and delivery categories remain data, not
-- client-controlled pricing inputs.
INSERT INTO "price_lists" (
    "id", "revision", "terms_revision", "currency", "parameters"
) VALUES (
    '20000000-0000-4000-8000-000000000020',
    'automatic-v0-czk',
    'terms-v0-cz',
    'CZK',
    '{
      "automaticQuote": {
        "machineRateMinorPerSecond": {"numerator": "1", "denominator": "2"},
        "laborRateMinorPerSecond": {"numerator": "1", "denominator": "1"},
        "amortizationRateMinorPerSecond": {"numerator": "1", "denominator": "10"},
        "reprintRate": {"numerator": "5", "denominator": "100"},
        "marginRate": {"numerator": "30", "denominator": "100"},
        "materialRateMinorPerMilligram": {
          "PLA": {"numerator": "1", "denominator": "20"},
          "PETG": {"numerator": "3", "denominator": "50"}
        },
        "handlingOrderFixedSeconds": "180",
        "handlingPlateSeconds": "120",
        "handlingPieceSeconds": "30",
        "handlingPackSeconds": "180",
        "shippingTripSeconds": "600",
        "shippingTripPricingDivisor": "4",
        "minimumPrintPriceMinor": "25000",
        "smallOrderWeightThresholdMilligrams": "100000",
        "smallOrderSurchargeMinor": "5000",
        "freeShippingPrintThresholdMinor": "100000",
        "expressMultiplier": {"numerator": "2", "denominator": "1"},
        "expressMaximumPlateCount": "2",
        "expressAvailableProductionWindowSeconds": "86400",
        "expressPackagingBufferSeconds": "7200",
        "maximumAutomaticQuantity": "1000",
        "maximumAutomaticAmountMinor": "1000000",
        "packingPaddingMicrometers": "5000",
        "fillCoefficient": {"numerator": "55", "denominator": "100"},
        "packagingWeightMilligrams": "150000",
        "paymentFeeRateBasisPoints": 150,
        "paymentFeeFixedMinor": "300",
        "paymentProviderConfig": {"provider": "configured"},
        "shipmentCategories": [
          {
            "id": "zbox",
            "maxXMicrometers": "600000",
            "maxYMicrometers": "450000",
            "maxZMicrometers": "350000",
            "maxDimensionSumMicrometers": "1400000",
            "maxWeightMilligrams": "15000000",
            "maxParcelVolumeCubicMicrometers": "94500000000000000",
            "carrierCostMinor": "8500",
            "customerShippingRateMinor": "8500",
            "packagingCostMinor": "1500"
          },
          {
            "id": "pickup",
            "maxXMicrometers": "1000000",
            "maxYMicrometers": "1000000",
            "maxZMicrometers": "1000000",
            "maxDimensionSumMicrometers": "3000000",
            "maxWeightMilligrams": "50000000",
            "maxParcelVolumeCubicMicrometers": "1000000000000000000",
            "carrierCostMinor": "0",
            "customerShippingRateMinor": "0",
            "packagingCostMinor": "1500"
          },
          {
            "id": "oversize",
            "maxXMicrometers": "2000000",
            "maxYMicrometers": "2000000",
            "maxZMicrometers": "2000000",
            "maxDimensionSumMicrometers": "6000000",
            "maxWeightMilligrams": "100000000",
            "maxParcelVolumeCubicMicrometers": "8000000000000000000",
            "carrierCostMinor": "20000",
            "customerShippingRateMinor": "20000",
            "packagingCostMinor": "3000"
          }
        ]
      }
    }'::jsonb
) ON CONFLICT ("currency", "revision") DO NOTHING;

-- A customer may change the endpoint after an automatic quote becomes ready
-- but before checkout acceptance. Replacement plans stay append-only; moving
-- the active binding invalidates the previous graph atomically. Individual
-- quotes and every order with payment/acceptance evidence remain frozen.
CREATE OR REPLACE FUNCTION "taven_prevent_shipment_plan_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_status "order_status";
    target_accepted_binding_id UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM "taven_lock_automatic_order_session"(NEW."order_id");

        SELECT "status", "accepted_order_price_binding_id"
          INTO target_order_status, target_accepted_binding_id
        FROM "orders"
        WHERE "id" = NEW."order_id"
        FOR UPDATE;

        IF EXISTS (SELECT 1 FROM "payments" WHERE "order_id" = NEW."order_id") THEN
            RAISE EXCEPTION 'shipment plans cannot be added after payment intent creation'
                USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_payment_guard';
        END IF;

        IF target_order_status IS DISTINCT FROM 'DRAFT'::"order_status"
           AND NOT (
               target_order_status = 'QUOTED'::"order_status"
               AND target_accepted_binding_id IS NULL
               AND EXISTS (
                   SELECT 1 FROM "automatic_order_origins"
                   WHERE "order_id" = NEW."order_id"
               )
           ) THEN
            RAISE EXCEPTION 'shipment plans can be added only while an automatic quote remains replaceable'
                USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_order_status_guard';
        END IF;

        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'shipment plans are insert-only topology'
        USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_insert_only_check';
END;
$$;

CREATE OR REPLACE FUNCTION "taven_validate_shipment_plan_fulfilment_slot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_order_id UUID;
    target_order_status "order_status";
    target_accepted_binding_id UUID;
BEGIN
    SELECT plan."order_id"
      INTO target_order_id
    FROM "shipment_plans" plan
    WHERE plan."id" = NEW."shipment_plan_id";

    IF target_order_id IS NOT NULL THEN
        PERFORM "taven_lock_automatic_order_session"(target_order_id);

        SELECT target_order."status", target_order."accepted_order_price_binding_id"
          INTO target_order_status, target_accepted_binding_id
        FROM "orders" target_order
        WHERE target_order."id" = target_order_id
        FOR UPDATE;

        IF target_order_status IS DISTINCT FROM 'DRAFT'::"order_status"
           AND NOT (
               target_order_status = 'QUOTED'::"order_status"
               AND target_accepted_binding_id IS NULL
               AND EXISTS (
                   SELECT 1 FROM "automatic_order_origins"
                   WHERE "order_id" = target_order_id
               )
               AND NOT EXISTS (
                   SELECT 1 FROM "payments" WHERE "order_id" = target_order_id
               )
           ) THEN
            RAISE EXCEPTION 'shipment plan allocations can be added only while an automatic quote remains replaceable'
                USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_slot_order_status_guard';
        END IF;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "shipment_plans" plan
        JOIN "fulfilment_slots" slot
          ON slot."id" = NEW."fulfilment_slot_id"
        WHERE plan."id" = NEW."shipment_plan_id"
          AND plan."order_price_binding_id" = NEW."order_price_binding_id"
          AND slot."order_id" = plan."order_id"
          AND slot."order_phase_id" = plan."order_phase_id"
    ) THEN
        RAISE EXCEPTION 'shipment plan allocation must use a slot from the same order and phase'
            USING ERRCODE = '23514', CONSTRAINT = 'shipment_plan_slot_scope_check';
    END IF;

    RETURN NEW;
END;
$$;

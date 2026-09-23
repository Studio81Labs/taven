-- CreateEnum
CREATE TYPE "inventory_mount_status" AS ENUM ('UNKNOWN', 'UNMOUNTED', 'MOUNTED');

-- CreateEnum
CREATE TYPE "inventory_receipt_kind" AS ENUM ('INITIAL', 'CORRECTION');

-- AlterTable
ALTER TABLE "inventories" ADD COLUMN     "mount_status" "inventory_mount_status" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "candidate_resource_estimates" ADD COLUMN     "machine_availability_revision_id" UUID;
ALTER TABLE "candidate_resource_estimates" ADD COLUMN     "machine_availability_selection_version" INTEGER;

-- AlterTable
ALTER TABLE "inventory_reservations" ADD COLUMN     "receipt_id" UUID;

-- CreateTable
CREATE TABLE "machine_availability_revisions" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_availability_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_availability_windows" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "machine_availability_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_availability_selections" (
    "machine_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "selection_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_availability_selections_pkey" PRIMARY KEY ("machine_id","node_id")
);

-- CreateTable
CREATE TABLE "inventory_receipts" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "inventory_id" UUID NOT NULL,
    "kind" "inventory_receipt_kind" NOT NULL,
    "supersedes_receipt_id" UUID,
    "received_milligrams" BIGINT NOT NULL,
    "vendor" VARCHAR(200) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "price_minor_units_numerator" BIGINT NOT NULL,
    "price_minor_units_denominator" BIGINT NOT NULL,
    "purchased_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "machine_availability_revisions_node_id_machine_id_created_a_idx" ON "machine_availability_revisions"("node_id", "machine_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "machine_availability_revisions_id_node_id_machine_id_key" ON "machine_availability_revisions"("id", "node_id", "machine_id");

-- CreateIndex
CREATE INDEX "machine_availability_windows_node_id_machine_id_starts_at_e_idx" ON "machine_availability_windows"("node_id", "machine_id", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "machine_availability_windows_revision_id_ordinal_key" ON "machine_availability_windows"("revision_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "machine_availability_selections_revision_id_node_id_machine_key" ON "machine_availability_selections"("revision_id", "node_id", "machine_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_receipts_supersedes_receipt_id_key" ON "inventory_receipts"("supersedes_receipt_id");

-- CreateIndex
CREATE INDEX "inventory_receipts_node_id_inventory_id_created_at_idx" ON "inventory_receipts"("node_id", "inventory_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_receipts_id_node_id_inventory_id_key" ON "inventory_receipts"("id", "node_id", "inventory_id");

-- AddForeignKey
ALTER TABLE "machine_availability_revisions" ADD CONSTRAINT "machine_availability_revisions_machine_id_node_id_fkey" FOREIGN KEY ("machine_id", "node_id") REFERENCES "machines"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_availability_windows" ADD CONSTRAINT "machine_availability_windows_revision_id_node_id_machine_i_fkey" FOREIGN KEY ("revision_id", "node_id", "machine_id") REFERENCES "machine_availability_revisions"("id", "node_id", "machine_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_availability_selections" ADD CONSTRAINT "machine_availability_selections_machine_id_node_id_fkey" FOREIGN KEY ("machine_id", "node_id") REFERENCES "machines"("id", "node_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_availability_selections" ADD CONSTRAINT "machine_availability_selections_revision_id_node_id_machin_fkey" FOREIGN KEY ("revision_id", "node_id", "machine_id") REFERENCES "machine_availability_revisions"("id", "node_id", "machine_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_receipts" ADD CONSTRAINT "inventory_receipts_inventory_id_node_id_machine_id_fkey" FOREIGN KEY ("inventory_id", "node_id", "machine_id") REFERENCES "inventories"("id", "node_id", "machine_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_receipts" ADD CONSTRAINT "inventory_receipts_supersedes_receipt_id_fkey" FOREIGN KEY ("supersedes_receipt_id") REFERENCES "inventory_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_resource_estimates" ADD CONSTRAINT "candidate_resource_estimates_machine_availability_revision_fkey" FOREIGN KEY ("machine_availability_revision_id", "node_id", "machine_id") REFERENCES "machine_availability_revisions"("id", "node_id", "machine_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_receipt_id_node_id_inventory_id_fkey" FOREIGN KEY ("receipt_id", "node_id", "inventory_id") REFERENCES "inventory_receipts"("id", "node_id", "inventory_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing stock has no inferred purchase or mount history. New receipts and
-- policies are explicit; existing reservations keep their historical evidence.
ALTER TABLE "inventory_receipts"
  ADD CONSTRAINT "inventory_receipts_amount_rate_check"
    CHECK ("received_milligrams" > 0 AND "price_minor_units_numerator" >= 0
      AND "price_minor_units_denominator" > 0),
  ADD CONSTRAINT "inventory_receipts_kind_reason_check"
    CHECK (("kind" = 'INITIAL' AND "supersedes_receipt_id" IS NULL AND "reason" IS NULL)
      OR ("kind" = 'CORRECTION' AND "supersedes_receipt_id" IS NOT NULL
        AND "reason" IS NOT NULL AND length(btrim("reason")) > 0));

CREATE UNIQUE INDEX "inventory_receipts_one_initial_per_inventory"
  ON "inventory_receipts" ("inventory_id") WHERE "kind" = 'INITIAL';

ALTER TABLE "machine_availability_selections"
  ADD CONSTRAINT "machine_availability_selection_version_check"
    CHECK ("selection_version" > 0);

ALTER TABLE "machine_availability_windows"
  ADD CONSTRAINT "machine_availability_window_bounds_check"
    CHECK ("starts_at" < "ends_at"),
  ADD CONSTRAINT "machine_availability_window_ordinal_check"
    CHECK ("ordinal" >= 0),
  ADD CONSTRAINT "machine_availability_windows_no_overlap"
    EXCLUDE USING gist (
      "revision_id" WITH =,
      tstzrange("starts_at", "ends_at", '[)') WITH &&
    );

ALTER TABLE "candidate_resource_estimates"
  ADD CONSTRAINT "candidate_availability_identity_check"
    CHECK (("machine_availability_revision_id" IS NULL AND "machine_availability_selection_version" IS NULL)
      OR ("machine_availability_revision_id" IS NOT NULL AND "machine_availability_selection_version" > 0));

-- Preserve existing live work without claiming that unused time is available.
-- The sentinel revision is not eligible for new candidate estimates. Operators
-- publish a new revision that covers these reservations before new admission.
DO $$
DECLARE machine_row record;
DECLARE interval_row record;
DECLARE bootstrap_revision_id uuid;
DECLARE ordinal_number integer;
BEGIN
  FOR machine_row IN
    SELECT DISTINCT "node_id", "machine_id"
    FROM "capacity_reservations"
    WHERE "status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
    ORDER BY "node_id", "machine_id"
  LOOP
    bootstrap_revision_id := gen_random_uuid();
    INSERT INTO "machine_availability_revisions" (
      "id", "node_id", "machine_id", "reason"
    ) VALUES (
      bootstrap_revision_id, machine_row."node_id", machine_row."machine_id",
      'LEGACY_LIVE_RESERVATION_BOOTSTRAP'
    );
    ordinal_number := 0;
    FOR interval_row IN
      SELECT "starts_at", "ends_at"
      FROM "capacity_reservations"
      WHERE "node_id" = machine_row."node_id"
        AND "machine_id" = machine_row."machine_id"
        AND "status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
      ORDER BY "starts_at", "ends_at", "id"
    LOOP
      INSERT INTO "machine_availability_windows" (
        "id", "revision_id", "node_id", "machine_id", "ordinal", "starts_at", "ends_at"
      ) VALUES (
        gen_random_uuid(), bootstrap_revision_id, machine_row."node_id",
        machine_row."machine_id", ordinal_number,
        interval_row."starts_at", interval_row."ends_at"
      );
      ordinal_number := ordinal_number + 1;
    END LOOP;
    INSERT INTO "machine_availability_selections" (
      "machine_id", "node_id", "revision_id", "selection_version"
    ) VALUES (
      machine_row."machine_id", machine_row."node_id", bootstrap_revision_id, 1
    );
  END LOOP;
END;
$$;

-- Captured work keeps its committed candidate identity, but the selected
-- window must still contain its live capacity and express material must still
-- be mounted at confirmation. The capture caller already locks machines and
-- inventories in canonical order before calling the validator.
CREATE OR REPLACE FUNCTION taven_phase_reservation_set_is_capture_eligible(target_set_id uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  PERFORM taven_lock_phase_reservation_set_for_capture(target_set_id);
  BEGIN
    PERFORM taven_validate_phase_reservation_set(target_set_id);
  EXCEPTION WHEN check_violation THEN
    RETURN false;
  END;
  IF EXISTS (
    SELECT 1
    FROM "production_reservations" production
    JOIN "machines" machine
      ON machine."id" = production."machine_id"
     AND machine."node_id" = production."node_id"
    JOIN "capacity_reservations" interval
      ON interval."production_reservation_id" = production."id"
     AND interval."node_id" = production."node_id"
    LEFT JOIN "machine_availability_selections" selection
      ON selection."machine_id" = machine."id"
     AND selection."node_id" = machine."node_id"
    WHERE production."phase_reservation_set_id" = target_set_id
      AND (
        machine."status" <> 'ACTIVE'
        OR selection."revision_id" IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM "machine_availability_windows" available
          WHERE available."revision_id" = selection."revision_id"
            AND available."starts_at" <= interval."starts_at"
            AND available."ends_at" >= interval."ends_at"
        )
      )
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "production_reservations" production
    JOIN "phase_resource_plan_jobs" plan_job
      ON plan_job."id" = production."phase_resource_plan_job_id"
     AND plan_job."node_id" = production."node_id"
    JOIN "candidate_resource_estimates" candidate
      ON candidate."id" = plan_job."candidate_resource_estimate_id"
     AND candidate."node_id" = plan_job."node_id"
    JOIN "shipment_plans" shipment_plan
      ON shipment_plan."id" = candidate."shipment_plan_id"
    JOIN "order_price_bindings" binding
      ON binding."id" = shipment_plan."order_price_binding_id"
    JOIN "price_snapshots" price_snapshot
      ON price_snapshot."id" = binding."price_snapshot_id"
    JOIN "inventories" inventory
      ON inventory."id" = production."inventory_id"
     AND inventory."node_id" = production."node_id"
    WHERE production."phase_reservation_set_id" = target_set_id
      AND price_snapshot."input_snapshot" #>> '{automaticQuote,expressRequested}' = 'true'
      AND inventory."mount_status" <> 'MOUNTED'
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION taven_guard_immutable_inventory_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior "inventory_receipts"%ROWTYPE;
DECLARE current_balance bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'inventory receipts are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_receipts_immutable';
  END IF;
  SELECT inventory."remaining_milligrams" INTO current_balance FROM "inventories" inventory
    WHERE inventory."id" = NEW."inventory_id" AND inventory."node_id" = NEW."node_id"
    FOR UPDATE NOWAIT;
  IF current_balance IS NOT NULL AND NEW."received_milligrams" < current_balance THEN
    RAISE EXCEPTION 'receipt mass cannot be below current lot balance'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_receipt_mass_balance_guard';
  END IF;
  IF NEW."kind" = 'CORRECTION' THEN
    SELECT * INTO prior FROM "inventory_receipts"
      WHERE "id" = NEW."supersedes_receipt_id";
    IF NOT FOUND OR prior."node_id" <> NEW."node_id"
       OR prior."machine_id" <> NEW."machine_id"
       OR prior."inventory_id" <> NEW."inventory_id" THEN
      RAISE EXCEPTION 'receipt correction must supersede evidence for the same lot'
        USING ERRCODE = '23514', CONSTRAINT = 'inventory_receipts_correction_scope';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "inventory_receipts_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "inventory_receipts"
FOR EACH ROW EXECUTE FUNCTION taven_guard_immutable_inventory_receipt();

CREATE FUNCTION taven_guard_immutable_availability_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'machine availability revisions and windows are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'machine_availability_immutable';
END;
$$;

CREATE TRIGGER "machine_availability_revisions_immutable"
BEFORE UPDATE OR DELETE ON "machine_availability_revisions"
FOR EACH ROW EXECUTE FUNCTION taven_guard_immutable_availability_revision();

CREATE TRIGGER "machine_availability_windows_immutable"
BEFORE UPDATE OR DELETE ON "machine_availability_windows"
FOR EACH ROW EXECUTE FUNCTION taven_guard_immutable_availability_revision();

CREATE FUNCTION taven_guard_availability_window_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "machines" machine
    WHERE machine."id" = NEW."machine_id" AND machine."node_id" = NEW."node_id"
    FOR UPDATE NOWAIT;
  IF EXISTS (
    SELECT 1 FROM "machine_availability_selections"
    WHERE "revision_id" = NEW."revision_id"
  ) THEN
    RAISE EXCEPTION 'selected machine availability windows cannot be extended'
      USING ERRCODE = '23514', CONSTRAINT = 'machine_availability_selected_windows_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "machine_availability_window_insert_guard"
BEFORE INSERT ON "machine_availability_windows"
FOR EACH ROW EXECUTE FUNCTION taven_guard_availability_window_insert();

CREATE FUNCTION taven_guard_machine_availability_selection()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE live_reservation uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'machine availability selection cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'machine_availability_selection_guard';
  END IF;
  IF TG_OP = 'UPDATE' AND
     (NEW."machine_id" <> OLD."machine_id" OR NEW."node_id" <> OLD."node_id"
       OR NEW."selection_version" <> OLD."selection_version" + 1) THEN
    RAISE EXCEPTION 'machine availability selection version must advance once'
      USING ERRCODE = '23514', CONSTRAINT = 'machine_availability_selection_guard';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."selection_version" <> 1 THEN
    RAISE EXCEPTION 'first machine availability selection must start at version one'
      USING ERRCODE = '23514', CONSTRAINT = 'machine_availability_selection_guard';
  END IF;

  -- NOWAIT avoids acquiring a lower-ranked machine lock behind a reservation
  -- after the selection row has already been locked by a direct SQL caller.
  PERFORM 1 FROM "machines" machine
    WHERE machine."id" = NEW."machine_id" AND machine."node_id" = NEW."node_id"
    FOR UPDATE NOWAIT;
  SELECT reservation."id" INTO live_reservation
  FROM "capacity_reservations" reservation
  WHERE reservation."machine_id" = NEW."machine_id"
    AND reservation."node_id" = NEW."node_id"
    AND reservation."status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
    AND NOT EXISTS (
      SELECT 1 FROM "machine_availability_windows" available
      WHERE available."revision_id" = NEW."revision_id"
        AND available."starts_at" <= reservation."starts_at"
        AND available."ends_at" >= reservation."ends_at"
    )
  ORDER BY reservation."id" LIMIT 1;
  IF live_reservation IS NOT NULL THEN
    RAISE EXCEPTION 'availability change excludes live reservation %', live_reservation
      USING ERRCODE = '23514', CONSTRAINT = 'machine_availability_live_reservation_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "machine_availability_selection_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "machine_availability_selections"
FOR EACH ROW EXECUTE FUNCTION taven_guard_machine_availability_selection();

CREATE FUNCTION taven_require_capacity_availability()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_revision uuid;
DECLARE selected_reason text;
BEGIN
  PERFORM 1 FROM "machines" machine
    WHERE machine."id" = NEW."machine_id" AND machine."node_id" = NEW."node_id"
    FOR UPDATE NOWAIT;
  SELECT selection."revision_id", revision."reason" INTO selected_revision, selected_reason
    FROM "machine_availability_selections" selection
    JOIN "machine_availability_revisions" revision
      ON revision."id" = selection."revision_id"
    WHERE selection."machine_id" = NEW."machine_id"
      AND selection."node_id" = NEW."node_id";
  IF selected_revision IS NULL
     OR selected_reason = 'LEGACY_LIVE_RESERVATION_BOOTSTRAP'
     OR NOT EXISTS (
    SELECT 1 FROM "machine_availability_windows" available
    WHERE available."revision_id" = selected_revision
      AND available."starts_at" <= NEW."starts_at"
      AND available."ends_at" >= NEW."ends_at"
  ) THEN
    RAISE EXCEPTION 'capacity reservation falls outside current machine availability'
      USING ERRCODE = '23514', CONSTRAINT = 'capacity_reservation_availability_window';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "capacity_reservation_availability_guard"
BEFORE INSERT ON "capacity_reservations"
FOR EACH ROW EXECUTE FUNCTION taven_require_capacity_availability();

CREATE FUNCTION taven_pin_inventory_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_receipt uuid;
BEGIN
  SELECT receipt."id" INTO active_receipt
  FROM "inventory_receipts" receipt
  WHERE receipt."node_id" = NEW."node_id"
    AND receipt."inventory_id" = NEW."inventory_id"
    AND NOT EXISTS (
      SELECT 1 FROM "inventory_receipts" successor
      WHERE successor."supersedes_receipt_id" = receipt."id"
    )
  ORDER BY receipt."created_at" DESC, receipt."id" DESC LIMIT 1;
  IF active_receipt IS NULL THEN
    RAISE EXCEPTION 'new inventory reservation requires explicit receipt evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_receipt_required';
  END IF;
  IF NEW."receipt_id" IS NOT NULL AND NEW."receipt_id" <> active_receipt THEN
    RAISE EXCEPTION 'inventory receipt changed before reservation'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_receipt_stale';
  END IF;
  NEW."receipt_id" := active_receipt;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "inventory_reservation_receipt_guard"
BEFORE INSERT ON "inventory_reservations"
FOR EACH ROW EXECUTE FUNCTION taven_pin_inventory_receipt();

CREATE FUNCTION taven_guard_inventory_unmount()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."mount_status" IS DISTINCT FROM OLD."mount_status"
     AND NEW."mount_status" <> 'MOUNTED'
     AND EXISTS (
       SELECT 1 FROM "production_reservations" reservation
       WHERE reservation."inventory_id" = NEW."id"
         AND reservation."node_id" = NEW."node_id"
         AND reservation."status" = 'PRINTING'
     ) THEN
    RAISE EXCEPTION 'printing inventory cannot be unmounted'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_printing_unmount_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "inventory_printing_unmount_guard"
BEFORE UPDATE OF "mount_status" ON "inventories"
FOR EACH ROW EXECUTE FUNCTION taven_guard_inventory_unmount();

CREATE FUNCTION taven_require_mounted_inventory_for_print()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_mount_status "inventory_mount_status";
BEGIN
  IF NEW."status" = 'PRINTING' AND OLD."status" IS DISTINCT FROM NEW."status" THEN
    SELECT "mount_status" INTO selected_mount_status FROM "inventories"
    WHERE "id" = NEW."inventory_id" AND "node_id" = NEW."node_id"
    FOR UPDATE NOWAIT;
    IF selected_mount_status IS DISTINCT FROM 'MOUNTED' THEN
      RAISE EXCEPTION 'printing requires physically mounted inventory'
        USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_mounted_inventory';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "production_reservation_mount_guard"
BEFORE UPDATE OF "status" ON "production_reservations"
FOR EACH ROW EXECUTE FUNCTION taven_require_mounted_inventory_for_print();
CREATE OR REPLACE FUNCTION taven_create_phase_reservation(
    target_node_id uuid,
    target_phase_resource_plan_id uuid,
    target_reservation_key text,
    reacquired_from_phase_reservation_set_id uuid DEFAULT NULL,
    reacquisition_payment_id uuid DEFAULT NULL
)
RETURNS TABLE (
    phase_reservation_set_id uuid,
    phase_reservation_set_status "phase_reservation_set_status",
    expires_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
    existing_set "phase_reservation_sets"%ROWTYPE;
    created_set_id uuid;
    target_order_phase_id uuid;
    target_order_id uuid;
    reserved_at timestamptz;
    reservation_expires_at timestamptz;
BEGIN
    IF target_reservation_key IS NULL OR btrim(target_reservation_key) = ''
       OR octet_length(target_reservation_key) > 255 THEN
        RAISE EXCEPTION 'reservation key must be a non-empty value up to 255 bytes'
            USING ERRCODE = '22023', CONSTRAINT = 'phase_reservation_set_reservation_key_input_check';
    END IF;

    -- A row lock cannot protect a key which has not been inserted yet. This
    -- transaction-scoped fence makes concurrent retries of the same key return
    -- the one durable reservation instead of racing to a unique violation.
    PERFORM pg_advisory_xact_lock(hashtextextended(target_reservation_key, 0));

    SELECT * INTO existing_set
    FROM "phase_reservation_sets"
    WHERE "reservation_key" = target_reservation_key
    FOR UPDATE;

    IF FOUND THEN
        IF existing_set."node_id" <> target_node_id
           OR existing_set."phase_resource_plan_id" <> target_phase_resource_plan_id
           OR existing_set."reacquired_from_phase_reservation_set_id"
                IS DISTINCT FROM reacquired_from_phase_reservation_set_id
           OR existing_set."reacquisition_payment_id"
                IS DISTINCT FROM reacquisition_payment_id THEN
            RAISE EXCEPTION 'reservation key is already bound to another phase resource plan'
                USING ERRCODE = '23505', CONSTRAINT = 'phase_reservation_sets_reservation_key_key';
        END IF;

        IF existing_set."status" NOT IN ('RESERVED', 'HELD')
           OR (
               existing_set."status" = 'RESERVED'
               AND existing_set."expires_at" <= clock_timestamp()
           ) THEN
            RAISE EXCEPTION 'a terminal reservation set cannot be revived; acquire a fresh plan and key'
                USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_terminal_reacquire_check';
        END IF;

        RETURN QUERY SELECT existing_set."id", existing_set."status", existing_set."expires_at";
        RETURN;
    END IF;

    SELECT plan."order_phase_id", phase."order_id"
    INTO target_order_phase_id, target_order_id
    FROM "phase_resource_plans" plan
    JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
    WHERE plan."id" = target_phase_resource_plan_id
      AND plan."node_id" = target_node_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'phase resource plan does not exist for the requested node'
            USING ERRCODE = '23503', CONSTRAINT = 'phase_reservation_sets_phase_resource_plan_id_node_id_fkey';
    END IF;

    -- Acquire the automatic-session fence before phase and resource locks.
    -- Insert triggers repeat this check with NOWAIT as a final topology guard.
    PERFORM taven_lock_automatic_order_session(target_order_id);

    -- Lock every mutable participant in one stable order before writing the
    -- reservation set. The existing trigger repeats the critical locks on
    -- transition, but doing it here avoids order-dependent deadlocks across
    -- concurrent multi-job plans.
    PERFORM 1 FROM "nodes" WHERE "id" = target_node_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'reservation node does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'phase_reservation_sets_node_id_fkey';
    END IF;

    PERFORM phase."id"
    FROM "order_phases" phase
    WHERE phase."id" = target_order_phase_id
    FOR SHARE;

    PERFORM plan."id"
    FROM "phase_resource_plans" plan
    WHERE plan."id" = target_phase_resource_plan_id
      AND plan."node_id" = target_node_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'phase resource plan does not exist for the requested node'
            USING ERRCODE = '23503', CONSTRAINT = 'phase_reservation_sets_phase_resource_plan_id_node_id_fkey';
    END IF;

    PERFORM slot."id"
    FROM "phase_resource_plan_slots" slot
    WHERE slot."phase_resource_plan_id" = target_phase_resource_plan_id
      AND slot."node_id" = target_node_id
    ORDER BY slot."fulfilment_slot_id", slot."id"
    FOR SHARE;

    PERFORM fulfilment_slot."id"
    FROM "fulfilment_slots" fulfilment_slot
    WHERE fulfilment_slot."id" IN (
        SELECT plan_slot."fulfilment_slot_id"
        FROM "phase_resource_plan_slots" plan_slot
        WHERE plan_slot."phase_resource_plan_id" = target_phase_resource_plan_id
          AND plan_slot."node_id" = target_node_id
    )
    ORDER BY fulfilment_slot."id"
    FOR SHARE;

    PERFORM plan_job."id"
    FROM "phase_resource_plan_jobs" plan_job
    JOIN "candidate_resource_estimates" candidate
      ON candidate."id" = plan_job."candidate_resource_estimate_id"
     AND candidate."node_id" = plan_job."node_id"
    WHERE plan_job."phase_resource_plan_id" = target_phase_resource_plan_id
      AND plan_job."node_id" = target_node_id
    ORDER BY candidate."id", plan_job."id"
    FOR SHARE OF plan_job, candidate;

    PERFORM profile."id"
    FROM "machine_profiles" profile
    WHERE profile."id" IN (
        SELECT candidate."machine_profile_id"
        FROM "phase_resource_plan_jobs" plan_job
        JOIN "candidate_resource_estimates" candidate
          ON candidate."id" = plan_job."candidate_resource_estimate_id"
         AND candidate."node_id" = plan_job."node_id"
        WHERE plan_job."phase_resource_plan_id" = target_phase_resource_plan_id
          AND plan_job."node_id" = target_node_id
    )
    ORDER BY profile."id"
    FOR UPDATE;

    PERFORM machine."id"
    FROM "machines" machine
    WHERE (machine."node_id", machine."id") IN (
        SELECT candidate."node_id", candidate."machine_id"
        FROM "phase_resource_plan_jobs" plan_job
        JOIN "candidate_resource_estimates" candidate
          ON candidate."id" = plan_job."candidate_resource_estimate_id"
         AND candidate."node_id" = plan_job."node_id"
        WHERE plan_job."phase_resource_plan_id" = target_phase_resource_plan_id
          AND plan_job."node_id" = target_node_id
    )
    ORDER BY machine."node_id", machine."id"
    FOR UPDATE;

    -- The machine rows are the publication fence. Every fresh candidate must
    -- still name the currently selected revision/version, and all indivisible
    -- plate intervals must fit wholly inside a selected availability window.
    IF EXISTS (
      SELECT 1
      FROM "phase_resource_plan_jobs" plan_job
      JOIN "candidate_resource_estimates" candidate
        ON candidate."id" = plan_job."candidate_resource_estimate_id"
       AND candidate."node_id" = plan_job."node_id"
      LEFT JOIN "machine_availability_selections" selection
        ON selection."machine_id" = candidate."machine_id"
       AND selection."node_id" = candidate."node_id"
      WHERE plan_job."phase_resource_plan_id" = target_phase_resource_plan_id
        AND plan_job."node_id" = target_node_id
        AND (
          selection."revision_id" IS NULL
          OR EXISTS (
            SELECT 1 FROM "machine_availability_revisions" revision
            WHERE revision."id" = selection."revision_id"
              AND revision."reason" = 'LEGACY_LIVE_RESERVATION_BOOTSTRAP'
          )
          OR candidate."machine_availability_revision_id" IS DISTINCT FROM selection."revision_id"
          OR candidate."machine_availability_selection_version" IS DISTINCT FROM selection."selection_version"
          OR EXISTS (
            SELECT 1 FROM "candidate_capacity_intervals" candidate_interval
            WHERE candidate_interval."candidate_resource_estimate_id" = candidate."id"
              AND candidate_interval."node_id" = candidate."node_id"
              AND NOT EXISTS (
                SELECT 1 FROM "machine_availability_windows" available
                WHERE available."revision_id" = selection."revision_id"
                  AND available."starts_at" <= candidate_interval."starts_at"
                  AND available."ends_at" >= candidate_interval."ends_at"
              )
          )
        )
    ) THEN
      RAISE EXCEPTION 'candidate machine availability changed or is unconfigured'
        USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_machine_availability';
    END IF;

    PERFORM calibration."id"
    FROM "machine_calibrations" calibration
    WHERE calibration."id" IN (
        SELECT candidate."machine_calibration_id"
        FROM "phase_resource_plan_jobs" plan_job
        JOIN "candidate_resource_estimates" candidate
          ON candidate."id" = plan_job."candidate_resource_estimate_id"
         AND candidate."node_id" = plan_job."node_id"
        WHERE plan_job."phase_resource_plan_id" = target_phase_resource_plan_id
          AND plan_job."node_id" = target_node_id
    )
    ORDER BY calibration."id"
    FOR UPDATE;

    PERFORM inventory."id"
    FROM "inventories" inventory
    WHERE (inventory."node_id", inventory."id") IN (
        SELECT candidate."node_id", candidate."inventory_id"
        FROM "phase_resource_plan_jobs" plan_job
        JOIN "candidate_resource_estimates" candidate
          ON candidate."id" = plan_job."candidate_resource_estimate_id"
         AND candidate."node_id" = plan_job."node_id"
        WHERE plan_job."phase_resource_plan_id" = target_phase_resource_plan_id
          AND plan_job."node_id" = target_node_id
    )
    ORDER BY inventory."node_id", inventory."id"
    FOR UPDATE;

    IF EXISTS (
      SELECT 1
      FROM "phase_resource_plan_jobs" plan_job
      JOIN "candidate_resource_estimates" candidate
        ON candidate."id" = plan_job."candidate_resource_estimate_id"
       AND candidate."node_id" = plan_job."node_id"
      JOIN "inventories" inventory
        ON inventory."id" = candidate."inventory_id"
       AND inventory."node_id" = candidate."node_id"
      JOIN "shipment_plans" shipment_plan
        ON shipment_plan."id" = candidate."shipment_plan_id"
      JOIN "order_price_bindings" binding
        ON binding."id" = shipment_plan."order_price_binding_id"
      JOIN "price_snapshots" price_snapshot
        ON price_snapshot."id" = binding."price_snapshot_id"
      WHERE plan_job."phase_resource_plan_id" = target_phase_resource_plan_id
        AND plan_job."node_id" = target_node_id
        AND price_snapshot."input_snapshot" #>> '{automaticQuote,expressRequested}' = 'true'
        AND inventory."mount_status" <> 'MOUNTED'
    ) THEN
      RAISE EXCEPTION 'express reservations require mounted inventory'
        USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_express_mount';
    END IF;

    PERFORM interval."id"
    FROM "candidate_capacity_intervals" interval
    JOIN "phase_resource_plan_jobs" plan_job
      ON plan_job."candidate_resource_estimate_id" = interval."candidate_resource_estimate_id"
     AND plan_job."node_id" = interval."node_id"
    WHERE plan_job."phase_resource_plan_id" = target_phase_resource_plan_id
      AND plan_job."node_id" = target_node_id
    ORDER BY interval."id"
    FOR SHARE OF interval;

    -- The exact payment TTL begins only after potentially blocking locks.
    reserved_at := clock_timestamp();
    reservation_expires_at := reserved_at + interval '15 minutes';

    INSERT INTO "phase_reservation_sets" (
        "id", "node_id", "phase_resource_plan_id", "reservation_key",
        "reacquired_from_phase_reservation_set_id", "reacquisition_payment_id",
        "status", "expires_at", "created_at", "updated_at"
    ) VALUES (
        gen_random_uuid(), target_node_id, target_phase_resource_plan_id, target_reservation_key,
        reacquired_from_phase_reservation_set_id, reacquisition_payment_id,
        'BUILDING', reservation_expires_at, reserved_at, reserved_at
    )
    RETURNING "id" INTO created_set_id;

    INSERT INTO "production_reservations" (
        "id", "node_id", "phase_reservation_set_id", "phase_resource_plan_id",
        "phase_resource_plan_job_id", "planned_job_key", "machine_id", "inventory_id",
        "slice_result_id", "print_config_revision_id", "machine_profile_id",
        "machine_calibration_id", "required_material_milligrams", "required_machine_seconds",
        "resource_snapshot", "status", "expires_at", "created_at", "updated_at"
    )
    SELECT
        gen_random_uuid(), plan_job."node_id", created_set_id, plan_job."phase_resource_plan_id",
        plan_job."id", plan_job."planned_job_key", candidate."machine_id", candidate."inventory_id",
        candidate."slice_result_id", candidate."print_config_revision_id", candidate."machine_profile_id",
        candidate."machine_calibration_id", candidate."required_material_milligrams",
        candidate."required_machine_seconds", candidate."resource_snapshot", 'RESERVED',
        reservation_expires_at, reserved_at, reserved_at
    FROM "phase_resource_plan_jobs" plan_job
    JOIN "candidate_resource_estimates" candidate
      ON candidate."id" = plan_job."candidate_resource_estimate_id"
     AND candidate."node_id" = plan_job."node_id"
    WHERE plan_job."phase_resource_plan_id" = target_phase_resource_plan_id
      AND plan_job."node_id" = target_node_id
    ORDER BY plan_job."planned_job_key", plan_job."id";

    INSERT INTO "inventory_reservations" (
        "id", "node_id", "production_reservation_id", "inventory_id",
        "reserved_milligrams", "status", "expires_at", "created_at", "updated_at"
    )
    SELECT
        gen_random_uuid(), production."node_id", production."id", production."inventory_id",
        production."required_material_milligrams", 'RESERVED', reservation_expires_at, reserved_at, reserved_at
    FROM "production_reservations" production
    WHERE production."phase_reservation_set_id" = created_set_id
    ORDER BY production."id";

    INSERT INTO "capacity_reservations" (
        "id", "node_id", "production_reservation_id", "candidate_capacity_interval_id",
        "machine_id", "starts_at", "ends_at", "status", "expires_at", "created_at", "updated_at"
    )
    SELECT
        gen_random_uuid(), production."node_id", production."id", interval."id",
        production."machine_id", interval."starts_at", interval."ends_at", 'RESERVED',
        reservation_expires_at, reserved_at, reserved_at
    FROM "production_reservations" production
    JOIN "phase_resource_plan_jobs" plan_job
      ON plan_job."id" = production."phase_resource_plan_job_id"
     AND plan_job."node_id" = production."node_id"
     AND plan_job."phase_resource_plan_id" = production."phase_resource_plan_id"
    JOIN "candidate_capacity_intervals" interval
      ON interval."candidate_resource_estimate_id" = plan_job."candidate_resource_estimate_id"
     AND interval."node_id" = production."node_id"
    WHERE production."phase_reservation_set_id" = created_set_id
    ORDER BY production."id", interval."interval_index", interval."id";

    UPDATE "phase_reservation_sets"
    SET "status" = 'RESERVED', "updated_at" = clock_timestamp()
    WHERE "id" = created_set_id;

    RETURN QUERY
    SELECT created_set_id, 'RESERVED'::"phase_reservation_set_status", reservation_expires_at;
END;
$$;

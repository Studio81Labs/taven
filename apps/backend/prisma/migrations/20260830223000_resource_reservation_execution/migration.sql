BEGIN;

ALTER TABLE "phase_reservation_sets"
    ADD COLUMN "reacquired_from_phase_reservation_set_id" UUID,
    ADD COLUMN "reacquisition_payment_id" UUID,
    ADD CONSTRAINT "phase_reservation_sets_reacquisition_identity_check"
        CHECK (
            ("reacquired_from_phase_reservation_set_id" IS NULL
             AND "reacquisition_payment_id" IS NULL)
            OR
            ("reacquired_from_phase_reservation_set_id" IS NOT NULL
             AND "reacquisition_payment_id" IS NOT NULL)
        ),
    ADD CONSTRAINT "phase_reservation_sets_reacquired_from_fkey"
        FOREIGN KEY ("reacquired_from_phase_reservation_set_id")
        REFERENCES "phase_reservation_sets"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "phase_reservation_sets_reacquisition_payment_fkey"
        FOREIGN KEY ("reacquisition_payment_id")
        REFERENCES "payments"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reservation execution is database-owned so the all-or-nothing resource claim
-- remains true for every caller, including worker processes.
CREATE FUNCTION taven_create_phase_reservation(
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

CREATE FUNCTION taven_release_phase_reservation_set(target_set_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    target_set "phase_reservation_sets"%ROWTYPE;
BEGIN
    SELECT * INTO target_set
    FROM "phase_reservation_sets"
    WHERE "id" = target_set_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'phase reservation set does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'phase_reservation_sets_pkey';
    END IF;

    IF target_set."status" IN ('RELEASED', 'EXPIRED', 'SETTLED') THEN
        RETURN false;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "production_reservations"
        WHERE "phase_reservation_set_id" = target_set_id
          AND "status" IN ('PRINTING', 'CONSUMED')
    ) THEN
        RAISE EXCEPTION 'a reservation set with printing or consumed production cannot be pre-print released'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_pre_print_release_check';
    END IF;

    UPDATE "inventory_reservations" inventory_reservation
    SET "status" = 'RELEASED', "updated_at" = clock_timestamp()
    FROM "production_reservations" production
    WHERE production."phase_reservation_set_id" = target_set_id
      AND inventory_reservation."production_reservation_id" = production."id"
      AND inventory_reservation."status" IN ('RESERVED', 'HELD', 'ALLOCATED');

    UPDATE "capacity_reservations" capacity_reservation
    SET "status" = 'RELEASED', "updated_at" = clock_timestamp()
    FROM "production_reservations" production
    WHERE production."phase_reservation_set_id" = target_set_id
      AND capacity_reservation."production_reservation_id" = production."id"
      AND capacity_reservation."status" IN ('RESERVED', 'HELD', 'SCHEDULED');

    UPDATE "production_reservations"
    SET "status" = 'RELEASED', "updated_at" = clock_timestamp()
    WHERE "phase_reservation_set_id" = target_set_id
      AND "status" IN ('RESERVED', 'HELD', 'SCHEDULED');

    UPDATE "phase_reservation_sets"
    SET "status" = 'RELEASED', "updated_at" = clock_timestamp()
    WHERE "id" = target_set_id;

    RETURN true;
END;
$$;

-- A failure before printing releases only the affected production group. The
-- remaining jobs in a complete phase reservation stay held; when this was the
-- final active group the parent becomes settled rather than pretending the
-- whole paid phase was released.
CREATE FUNCTION taven_release_production_reservation_before_print(
    target_production_reservation_id uuid
)
RETURNS "phase_reservation_set_status"
LANGUAGE plpgsql
AS $$
DECLARE
    target_set_id uuid;
    target_set_status "phase_reservation_set_status";
    target_production "production_reservations"%ROWTYPE;
BEGIN
    SELECT "phase_reservation_set_id"
    INTO target_set_id
    FROM "production_reservations"
    WHERE "id" = target_production_reservation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'production reservation does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'production_reservations_pkey';
    END IF;

    SELECT "status"
    INTO target_set_status
    FROM "phase_reservation_sets"
    WHERE "id" = target_set_id
    FOR UPDATE;

    SELECT * INTO target_production
    FROM "production_reservations"
    WHERE "id" = target_production_reservation_id
      AND "phase_reservation_set_id" = target_set_id
    FOR UPDATE;

    IF target_production."status" = 'RELEASED' THEN
        IF EXISTS (
            SELECT 1
            FROM "inventory_reservations"
            WHERE "production_reservation_id" = target_production."id"
              AND "status" <> 'RELEASED'
        ) OR EXISTS (
            SELECT 1
            FROM "capacity_reservations"
            WHERE "production_reservation_id" = target_production."id"
              AND "status" <> 'RELEASED'
        ) THEN
            RAISE EXCEPTION 'released production reservation has inconsistent children'
                USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_pre_print_release_check';
        END IF;
        RETURN target_set_status;
    END IF;

    IF target_set_status <> 'HELD'
       OR target_production."status" NOT IN ('HELD', 'SCHEDULED') THEN
        RAISE EXCEPTION 'only held or scheduled production can be released before printing'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_pre_print_release_check';
    END IF;

    UPDATE "inventory_reservations"
    SET "status" = 'RELEASED', "updated_at" = clock_timestamp()
    WHERE "production_reservation_id" = target_production."id"
      AND "node_id" = target_production."node_id"
      AND "status" IN ('HELD', 'ALLOCATED');

    IF NOT FOUND THEN
        RAISE EXCEPTION 'pre-print production has no held or allocated inventory reservation'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_pre_print_release_check';
    END IF;

    UPDATE "capacity_reservations"
    SET "status" = 'RELEASED', "updated_at" = clock_timestamp()
    WHERE "production_reservation_id" = target_production."id"
      AND "node_id" = target_production."node_id"
      AND "status" IN ('HELD', 'SCHEDULED');

    IF NOT FOUND THEN
        RAISE EXCEPTION 'pre-print production has no held or scheduled capacity reservation'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_pre_print_release_check';
    END IF;

    UPDATE "production_reservations"
    SET "status" = 'RELEASED', "updated_at" = clock_timestamp()
    WHERE "id" = target_production."id";

    IF NOT EXISTS (
        SELECT 1
        FROM "production_reservations"
        WHERE "phase_reservation_set_id" = target_set_id
          AND "status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
    ) THEN
        UPDATE "phase_reservation_sets"
        SET "status" = 'SETTLED', "updated_at" = clock_timestamp()
        WHERE "id" = target_set_id
          AND "status" = 'HELD';
    END IF;

    SELECT "status"
    INTO target_set_status
    FROM "phase_reservation_sets"
    WHERE "id" = target_set_id;
    RETURN target_set_status;
END;
$$;

CREATE FUNCTION taven_expire_reserved_phase_reservation_set(target_set_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    target_set "phase_reservation_sets"%ROWTYPE;
BEGIN
    SELECT * INTO target_set
    FROM "phase_reservation_sets"
    WHERE "id" = target_set_id
    FOR UPDATE;

    IF NOT FOUND OR target_set."status" <> 'RESERVED'
       OR target_set."expires_at" > clock_timestamp() THEN
        RETURN false;
    END IF;

    UPDATE "inventory_reservations" inventory_reservation
    SET "status" = 'EXPIRED', "updated_at" = clock_timestamp()
    FROM "production_reservations" production
    WHERE production."phase_reservation_set_id" = target_set_id
      AND inventory_reservation."production_reservation_id" = production."id"
      AND inventory_reservation."status" = 'RESERVED';

    UPDATE "capacity_reservations" capacity_reservation
    SET "status" = 'EXPIRED', "updated_at" = clock_timestamp()
    FROM "production_reservations" production
    WHERE production."phase_reservation_set_id" = target_set_id
      AND capacity_reservation."production_reservation_id" = production."id"
      AND capacity_reservation."status" = 'RESERVED';

    UPDATE "production_reservations"
    SET "status" = 'EXPIRED', "updated_at" = clock_timestamp()
    WHERE "phase_reservation_set_id" = target_set_id
      AND "status" = 'RESERVED';

    UPDATE "phase_reservation_sets"
    SET "status" = 'EXPIRED', "updated_at" = clock_timestamp()
    WHERE "id" = target_set_id
      AND "status" = 'RESERVED';

    RETURN true;
END;
$$;

CREATE FUNCTION taven_expire_reserved_phase_reservation_sets(batch_limit integer)
RETURNS TABLE (phase_reservation_set_id uuid)
LANGUAGE plpgsql
AS $$
DECLARE
    target_set_id uuid;
BEGIN
    IF batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 1000 THEN
        RAISE EXCEPTION 'reservation expiry batch limit must be 1 through 1000'
            USING ERRCODE = '22023', CONSTRAINT = 'phase_reservation_expiry_batch_limit_check';
    END IF;

    FOR target_set_id IN
        SELECT reservation_set."id"
        FROM "phase_reservation_sets" reservation_set
        WHERE reservation_set."status" = 'RESERVED'
          AND reservation_set."expires_at" <= clock_timestamp()
        ORDER BY reservation_set."expires_at", reservation_set."id"
        FOR UPDATE SKIP LOCKED
        LIMIT batch_limit
    LOOP
        IF taven_expire_reserved_phase_reservation_set(target_set_id) THEN
            phase_reservation_set_id := target_set_id;
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$;

CREATE FUNCTION taven_settle_printing_production_reservation(
    target_production_reservation_id uuid,
    actual_consumed_milligrams bigint
)
RETURNS "phase_reservation_set_status"
LANGUAGE plpgsql
AS $$
DECLARE
    target_set_id uuid;
    target_production "production_reservations"%ROWTYPE;
    stored_consumption bigint;
    resulting_set_status "phase_reservation_set_status";
BEGIN
    IF actual_consumed_milligrams IS NULL OR actual_consumed_milligrams < 0 THEN
        RAISE EXCEPTION 'actual consumed material must be a non-negative number of milligrams'
            USING ERRCODE = '22023', CONSTRAINT = 'inventory_reservation_consumption_input_check';
    END IF;

    SELECT "phase_reservation_set_id"
    INTO target_set_id
    FROM "production_reservations"
    WHERE "id" = target_production_reservation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'production reservation does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'production_reservations_pkey';
    END IF;

    -- Match whole-set and per-production release lock order.
    PERFORM 1
    FROM "phase_reservation_sets"
    WHERE "id" = target_set_id
    FOR UPDATE;

    SELECT * INTO target_production
    FROM "production_reservations"
    WHERE "id" = target_production_reservation_id
      AND "phase_reservation_set_id" = target_set_id
    FOR UPDATE;

    IF target_production."status" = 'CONSUMED' THEN
        SELECT "consumed_milligrams" INTO stored_consumption
        FROM "inventory_reservations"
        WHERE "production_reservation_id" = target_production."id"
          AND "node_id" = target_production."node_id";
        IF stored_consumption IS DISTINCT FROM actual_consumed_milligrams THEN
            RAISE EXCEPTION 'production reservation was already settled with a different actual consumption'
                USING ERRCODE = '23514', CONSTRAINT = 'inventory_reservation_consumption_idempotency_check';
        END IF;
        SELECT "status" INTO resulting_set_status
        FROM "phase_reservation_sets"
        WHERE "id" = target_production."phase_reservation_set_id";
        RETURN resulting_set_status;
    END IF;

    IF target_production."status" <> 'PRINTING' THEN
        RAISE EXCEPTION 'only a printing production reservation can be settled'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_printing_settlement_check';
    END IF;

    IF actual_consumed_milligrams > target_production."required_material_milligrams" THEN
        RAISE EXCEPTION 'actual consumed material cannot exceed the reserved amount'
            USING ERRCODE = '22003', CONSTRAINT = 'inventory_reservation_consumption_input_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "capacity_reservations"
        WHERE "production_reservation_id" = target_production."id"
          AND "node_id" = target_production."node_id"
          AND "status" <> 'PRINTING'
    ) THEN
        RAISE EXCEPTION 'printing production reservation has capacity outside its active printing group'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_printing_settlement_check';
    END IF;

    UPDATE "inventory_reservations"
    SET "status" = 'CONSUMED',
        "consumed_milligrams" = actual_consumed_milligrams,
        "updated_at" = clock_timestamp()
    WHERE "production_reservation_id" = target_production."id"
      AND "node_id" = target_production."node_id"
      AND "status" = 'ALLOCATED';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'printing production reservation has no allocated inventory reservation'
            USING ERRCODE = '23514', CONSTRAINT = 'production_reservation_printing_settlement_check';
    END IF;

    UPDATE "capacity_reservations"
    SET "status" = 'COMPLETED', "updated_at" = clock_timestamp()
    WHERE "production_reservation_id" = target_production."id"
      AND "node_id" = target_production."node_id"
      AND "status" = 'PRINTING';

    UPDATE "production_reservations"
    SET "status" = 'CONSUMED', "updated_at" = clock_timestamp()
    WHERE "id" = target_production."id"
      AND "status" = 'PRINTING';

    -- A completed capacity interval is no longer part of the active exclusion
    -- range. Inventory accounting debits only the actual amount and releases
    -- the unused material atomically in its existing trigger.
    IF NOT EXISTS (
        SELECT 1
        FROM "production_reservations"
        WHERE "phase_reservation_set_id" = target_production."phase_reservation_set_id"
          AND "status" IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
    ) THEN
        UPDATE "phase_reservation_sets"
        SET "status" = 'SETTLED', "updated_at" = clock_timestamp()
        WHERE "id" = target_production."phase_reservation_set_id"
          AND "status" = 'HELD';
    END IF;

    SELECT "status" INTO resulting_set_status
    FROM "phase_reservation_sets"
    WHERE "id" = target_production."phase_reservation_set_id";
    RETURN resulting_set_status;
END;
$$;

CREATE FUNCTION taven_reacquire_phase_reservation_for_capture(
    previous_phase_reservation_set_id uuid,
    target_node_id uuid,
    target_phase_resource_plan_id uuid,
    target_reservation_key text,
    target_payment_id uuid
)
RETURNS TABLE (
    phase_reservation_set_id uuid,
    phase_reservation_set_status "phase_reservation_set_status",
    expires_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
    previous_set "phase_reservation_sets"%ROWTYPE;
    existing_replacement_set "phase_reservation_sets"%ROWTYPE;
    target_order_phase_id uuid;
    target_order_id uuid;
    target_payment "payments"%ROWTYPE;
BEGIN
    SELECT plan."order_phase_id", phase."order_id"
    INTO target_order_phase_id, target_order_id
    FROM "phase_resource_plans" plan
    JOIN "order_phases" phase ON phase."id" = plan."order_phase_id"
    WHERE plan."id" = target_phase_resource_plan_id
      AND plan."node_id" = target_node_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'replacement phase resource plan does not exist for the requested node'
            USING ERRCODE = '23503', CONSTRAINT = 'phase_reservation_sets_phase_resource_plan_id_node_id_fkey';
    END IF;

    IF target_reservation_key IS NULL OR btrim(target_reservation_key) = ''
       OR octet_length(target_reservation_key) > 255 THEN
        RAISE EXCEPTION 'reservation key must be a non-empty value up to 255 bytes'
            USING ERRCODE = '22023', CONSTRAINT = 'phase_reservation_set_reservation_key_input_check';
    END IF;

    -- Keep reacquisition's lock order identical to a direct reservation:
    -- serialize the reservation identity before taking the order-session lock.
    -- Otherwise a concurrent direct reservation can hold this fence while this
    -- path holds the order lock and waits for the fence.
    PERFORM pg_advisory_xact_lock(hashtextextended(target_reservation_key, 0));

    SELECT * INTO existing_replacement_set
    FROM "phase_reservation_sets"
    WHERE "reservation_key" = target_reservation_key
    FOR UPDATE;

    IF FOUND THEN
        IF existing_replacement_set."node_id" <> target_node_id
           OR existing_replacement_set."phase_resource_plan_id" <> target_phase_resource_plan_id
           OR existing_replacement_set."reacquired_from_phase_reservation_set_id"
                IS DISTINCT FROM previous_phase_reservation_set_id
           OR existing_replacement_set."reacquisition_payment_id"
                IS DISTINCT FROM target_payment_id THEN
            RAISE EXCEPTION 'reservation key is already bound to another reacquisition identity'
                USING ERRCODE = '23505', CONSTRAINT = 'phase_reservation_sets_reacquisition_identity_check';
        END IF;

        IF existing_replacement_set."status" NOT IN ('RESERVED', 'HELD')
           OR (
               existing_replacement_set."status" = 'RESERVED'
               AND existing_replacement_set."expires_at" <= clock_timestamp()
           ) THEN
            RAISE EXCEPTION 'terminal replacement reservation cannot be revived'
                USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_terminal_reacquire_check';
        END IF;

        RETURN QUERY
        SELECT existing_replacement_set."id",
               existing_replacement_set."status",
               existing_replacement_set."expires_at";
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "phase_reservation_sets"
        WHERE "phase_resource_plan_id" = target_phase_resource_plan_id
    ) THEN
        RAISE EXCEPTION 'reacquisition plan is already bound to another reservation attempt'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_fresh_plan_reacquire_check';
    END IF;

    PERFORM taven_lock_automatic_order_session(target_order_id);

    SELECT * INTO target_payment
    FROM "payments"
    WHERE "id" = target_payment_id
      AND "order_id" = target_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'capture payment does not exist for the replacement plan order'
            USING ERRCODE = '23503', CONSTRAINT = 'payments_order_id_fkey';
    END IF;

    IF target_payment."status" NOT IN ('PENDING', 'CAPTURED')
       OR target_payment."capture_authorized" IS DISTINCT FROM true
       OR target_payment."capture_cutoff_at" IS NOT NULL
       OR (
           target_payment."role" IN ('FULL', 'DEPOSIT')
           AND (
               target_payment."checkout_capture_expires_at" IS NULL
               OR target_payment."checkout_capture_expires_at" <= clock_timestamp()
           )
       )
       OR (
           target_payment."role" = 'BALANCE'
           AND (
               target_payment."balance_due_at" IS NULL
               OR target_payment."balance_due_at" <= clock_timestamp()
           )
       ) THEN
        RAISE EXCEPTION 'reservation reacquisition requires an authorized capture inside its persisted payment window'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_capture_reacquire_guard_check';
    END IF;

    SELECT * INTO previous_set
    FROM "phase_reservation_sets"
    WHERE "id" = previous_phase_reservation_set_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'previous phase reservation set does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'phase_reservation_sets_pkey';
    END IF;

    IF previous_set."status" NOT IN ('RELEASED', 'EXPIRED')
       OR previous_set."node_id" <> target_node_id
       OR previous_set."phase_resource_plan_id" = target_phase_resource_plan_id
       OR previous_set."reservation_key" = target_reservation_key THEN
        RAISE EXCEPTION 'reacquisition requires a terminal set, fresh plan, and fresh reservation key'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_terminal_reacquire_check';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "phase_resource_plans" previous_plan
        WHERE previous_plan."id" = previous_set."phase_resource_plan_id"
          AND previous_plan."node_id" = previous_set."node_id"
          AND previous_plan."order_phase_id" = target_order_phase_id
    ) THEN
        RAISE EXCEPTION 'replacement reservation must remain scoped to the previous order phase'
            USING ERRCODE = '23514', CONSTRAINT = 'phase_reservation_set_terminal_reacquire_check';
    END IF;

    RETURN QUERY
    SELECT *
    FROM taven_create_phase_reservation(
        target_node_id,
        target_phase_resource_plan_id,
        target_reservation_key,
        previous_phase_reservation_set_id,
        target_payment_id
    );
END;
$$;

COMMIT;

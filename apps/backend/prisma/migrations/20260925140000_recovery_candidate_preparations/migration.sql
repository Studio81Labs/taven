-- CreateEnum
CREATE TYPE "RecoveryCandidatePreparationKind" AS ENUM ('JOB_REPLACEMENT', 'LOST_CLAIM_REPRINT');

-- CreateTable
CREATE TABLE "recovery_candidate_preparations" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_phase_id" UUID NOT NULL,
    "shipment_plan_id" UUID NOT NULL,
    "kind" "RecoveryCandidatePreparationKind" NOT NULL,
    "target_id" UUID NOT NULL,
    "source_job_id" UUID,
    "replacement_request_id" UUID,
    "claim_id" UUID,
    "predecessor_shipment_id" UUID,
    "incident_evidence_id" UUID,
    "generation" INTEGER NOT NULL,
    "source_job_ids" UUID[] NOT NULL,
    "source_scope_fingerprint" VARCHAR(64) NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operator_id" UUID NOT NULL,
    "operator_session_id" UUID NOT NULL,
    "idempotency_record_id" UUID NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,

    CONSTRAINT "recovery_candidate_preparations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_candidate_dispatches" (
    "id" UUID NOT NULL,
    "preparation_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_phase_id" UUID NOT NULL,
    "shipment_plan_id" UUID NOT NULL,
    "source_job_id" UUID NOT NULL,
    "source_fingerprint" VARCHAR(64) NOT NULL,
    "dispatch_job_id" UUID NOT NULL,
    "outbox_message_id" UUID NOT NULL,

    CONSTRAINT "recovery_candidate_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recovery_candidate_preparations_order_id_kind_target_id_req_idx" ON "recovery_candidate_preparations"("order_id", "kind", "target_id", "requested_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_candidate_preparations_kind_target_id_generation_key" ON "recovery_candidate_preparations"("kind", "target_id", "generation");
CREATE UNIQUE INDEX "recovery_candidate_preparations_idempotency_record_id_key" ON "recovery_candidate_preparations"("idempotency_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_candidate_preparations_id_node_id_order_id_order_p_key" ON "recovery_candidate_preparations"("id", "node_id", "order_id", "order_phase_id", "shipment_plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_candidate_dispatches_outbox_message_id_key" ON "recovery_candidate_dispatches"("outbox_message_id");

-- CreateIndex
CREATE INDEX "recovery_candidate_dispatches_preparation_id_source_job_id_idx" ON "recovery_candidate_dispatches"("preparation_id", "source_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_candidate_dispatches_preparation_id_source_job_id__key" ON "recovery_candidate_dispatches"("preparation_id", "source_job_id", "dispatch_job_id");

-- AddForeignKey
ALTER TABLE "recovery_candidate_dispatches" ADD CONSTRAINT "recovery_candidate_dispatches_preparation_id_node_id_order_fkey" FOREIGN KEY ("preparation_id", "node_id", "order_id", "order_phase_id", "shipment_plan_id") REFERENCES "recovery_candidate_preparations"("id", "node_id", "order_id", "order_phase_id", "shipment_plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Recovery provenance is append-only. Historical replacement Jobs are left unchanged.
ALTER TABLE recovery_candidate_preparations
  ADD CONSTRAINT recovery_preparation_generation_check CHECK (generation > 0),
  ADD CONSTRAINT recovery_preparation_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  ADD CONSTRAINT recovery_preparation_sources_check CHECK (cardinality(source_job_ids) BETWEEN 1 AND 256),
  ADD CONSTRAINT recovery_preparation_kind_check CHECK (
    (kind = 'JOB_REPLACEMENT' AND source_job_id = target_id
      AND replacement_request_id IS NOT NULL AND claim_id IS NULL
      AND predecessor_shipment_id IS NULL AND incident_evidence_id IS NULL
      AND source_job_ids = ARRAY[source_job_id]::uuid[])
    OR (kind = 'LOST_CLAIM_REPRINT' AND claim_id = target_id
      AND source_job_id IS NULL AND replacement_request_id IS NULL
      AND predecessor_shipment_id IS NOT NULL AND incident_evidence_id IS NOT NULL)
  ),
  ADD CONSTRAINT recovery_preparation_node_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE RESTRICT,
  ADD CONSTRAINT recovery_preparation_order_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  ADD CONSTRAINT recovery_preparation_phase_fkey FOREIGN KEY (order_phase_id, order_id) REFERENCES order_phases(id, order_id) ON DELETE RESTRICT,
  ADD CONSTRAINT recovery_preparation_plan_fkey FOREIGN KEY (shipment_plan_id, order_id, order_phase_id) REFERENCES shipment_plans(id, order_id, order_phase_id) ON DELETE RESTRICT,
  ADD CONSTRAINT recovery_preparation_source_job_fkey FOREIGN KEY (source_job_id, shipment_plan_id, order_id, order_phase_id) REFERENCES jobs(id, shipment_plan_id, order_id, order_phase_id) ON DELETE RESTRICT,
  ADD CONSTRAINT recovery_preparation_request_fkey FOREIGN KEY (replacement_request_id) REFERENCES replacement_requests(id) ON DELETE RESTRICT,
  ADD CONSTRAINT recovery_preparation_claim_fkey FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE RESTRICT,
  ADD CONSTRAINT recovery_preparation_predecessor_fkey FOREIGN KEY (predecessor_shipment_id, shipment_plan_id, order_id, order_phase_id) REFERENCES shipments(id, shipment_plan_id, order_id, order_phase_id) ON DELETE RESTRICT,
  ADD CONSTRAINT recovery_preparation_incident_fkey FOREIGN KEY (incident_evidence_id, predecessor_shipment_id) REFERENCES shipment_provider_events(id, shipment_id) ON DELETE RESTRICT,
  ADD CONSTRAINT recovery_preparation_operator_fkey FOREIGN KEY (operator_id) REFERENCES operator_identities(id) ON DELETE RESTRICT;
ALTER TABLE recovery_candidate_preparations
  ADD CONSTRAINT recovery_preparation_idempotency_fkey
  FOREIGN KEY (idempotency_record_id) REFERENCES idempotency_records(id) ON DELETE RESTRICT;

ALTER TABLE recovery_candidate_dispatches
  ADD CONSTRAINT recovery_dispatch_source_job_fkey FOREIGN KEY (source_job_id, shipment_plan_id, order_id, order_phase_id) REFERENCES jobs(id, shipment_plan_id, order_id, order_phase_id) ON DELETE RESTRICT,
  ADD CONSTRAINT recovery_dispatch_outbox_fkey FOREIGN KEY (outbox_message_id) REFERENCES outbox_messages(id) ON DELETE RESTRICT,
  ADD CONSTRAINT recovery_dispatch_fingerprint_check CHECK (source_fingerprint ~ '^[0-9a-f]{64}$');

ALTER TABLE recovery_candidate_preparations
  ADD CONSTRAINT recovery_preparation_fingerprint_check CHECK (source_scope_fingerprint ~ '^[0-9a-f]{64}$');

CREATE FUNCTION taven_recovery_source_fingerprint(target_job_id uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(digest(concat_ws('|',
    job.id::text, plan_job.id::text, candidate.id::text,
    min(slot.order_item_id::text), candidate.model_geometry_id::text,
    candidate.print_config_revision_id::text, candidate.quantity::text,
    string_agg(plan_slot.fulfilment_slot_id::text, ',' ORDER BY plan_slot.fulfilment_slot_id)
  ), 'sha256'), 'hex')
  FROM jobs job
  JOIN phase_resource_plan_jobs plan_job ON plan_job.id = job.phase_resource_plan_job_id
  JOIN candidate_resource_estimates candidate ON candidate.id = plan_job.candidate_resource_estimate_id
  JOIN phase_resource_plan_slots plan_slot ON plan_slot.phase_resource_plan_job_id = plan_job.id
  JOIN fulfilment_slots slot ON slot.id = plan_slot.fulfilment_slot_id
  WHERE job.id = target_job_id
  GROUP BY job.id, plan_job.id, candidate.id;
$$;

CREATE FUNCTION taven_validate_recovery_preparation_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_count integer;
BEGIN
  -- Sessions may later be pruned, so validate attribution on insert without
  -- retaining a foreign key that would block session cleanup.
  IF NOT EXISTS (
    SELECT 1 FROM operator_sessions operator_session
    WHERE operator_session.id = NEW.operator_session_id
      AND operator_session.operator_id = NEW.operator_id
  ) THEN
    RAISE EXCEPTION 'recovery preparation operator session is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_preparation_operator_session_check';
  END IF;
  IF NEW.kind = 'JOB_REPLACEMENT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM replacement_requests request
      JOIN jobs job ON job.id = request.source_job_id
      WHERE request.id = NEW.replacement_request_id AND request.source_job_id = NEW.source_job_id
        AND request.order_id = NEW.order_id AND request.order_phase_id = NEW.order_phase_id
        AND request.shipment_plan_id = NEW.shipment_plan_id AND job.node_id = NEW.node_id
        AND request.status = 'OPEN' AND request.deadline_at > clock_timestamp()
        AND job.status IN ('FAILED', 'QC_REJECTED')
        AND NOT EXISTS (SELECT 1 FROM jobs successor WHERE successor.replaces_job_id = job.id)
    ) THEN
      RAISE EXCEPTION 'replacement preparation scope is invalid'
        USING ERRCODE = '23514', CONSTRAINT = 'recovery_preparation_scope_check';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM claims claim
      JOIN orders parent_order ON parent_order.id = claim.order_id
      JOIN shipments predecessor ON predecessor.id = NEW.predecessor_shipment_id
      JOIN shipment_provider_events evidence ON evidence.id = NEW.incident_evidence_id
      WHERE claim.id = NEW.claim_id AND claim.order_id = NEW.order_id
        AND parent_order.status = 'SHIPPED'
        AND claim.order_phase_id = NEW.order_phase_id
        AND claim.origin = 'SHIPMENT_INCIDENT'
        AND claim.status IN ('OPEN', 'ACTIVE')
        AND predecessor.order_id = NEW.order_id AND predecessor.order_phase_id = NEW.order_phase_id
        AND predecessor.shipment_plan_id = NEW.shipment_plan_id
        AND predecessor.status = 'LOST'
        AND evidence.shipment_id = predecessor.id AND evidence.kind = 'LOST'
        AND evidence.id = (
          SELECT selected.id FROM shipment_provider_events selected
          WHERE selected.shipment_id = predecessor.id AND selected.kind = 'LOST'
          ORDER BY selected.occurred_at DESC, selected.id DESC LIMIT 1)
        AND (
          (claim.status = 'OPEN' AND claim.incident_shipment_id = predecessor.id
            AND NOT EXISTS (
              SELECT 1 FROM claim_slot_resolutions resolution
              WHERE resolution.claim_id = claim.id
                AND (resolution.replacement_shipment_id IS NOT NULL
                  OR resolution.replacement_request_id IS NOT NULL)))
          OR (claim.status = 'ACTIVE'
            AND (predecessor.reprint_claim_id = claim.id OR EXISTS (
              SELECT 1 FROM reshipment_authorizations reship
              WHERE reship.reshipment_shipment_id = predecessor.id
                AND reship.claim_id = claim.id))
            AND NOT EXISTS (
              SELECT 1 FROM claim_slot_resolutions resolution
              WHERE resolution.claim_id = claim.id
                AND (resolution.replacement_shipment_id IS DISTINCT FROM predecessor.id
                  OR resolution.status IS DISTINCT FROM 'PENDING')))
        )
        AND NOT EXISTS (
          SELECT 1 FROM shipments successor
          WHERE successor.replaces_shipment_id = predecessor.id)
    ) THEN
      RAISE EXCEPTION 'claim preparation scope is invalid'
        USING ERRCODE = '23514', CONSTRAINT = 'recovery_preparation_scope_check';
    END IF;
  END IF;
  SELECT count(*) INTO source_count FROM jobs job
    WHERE job.id = ANY(NEW.source_job_ids) AND job.node_id = NEW.node_id
      AND job.order_id = NEW.order_id AND job.order_phase_id = NEW.order_phase_id
      AND job.shipment_plan_id = NEW.shipment_plan_id;
  IF source_count <> cardinality(NEW.source_job_ids)
     OR (SELECT count(DISTINCT id) FROM unnest(NEW.source_job_ids) AS id) <> cardinality(NEW.source_job_ids) THEN
    RAISE EXCEPTION 'recovery preparation source partition is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_preparation_sources_scope_check';
  END IF;
  IF NEW.kind = 'LOST_CLAIM_REPRINT' AND (
    (SELECT array_agg(plan_slot.fulfilment_slot_id ORDER BY plan_slot.fulfilment_slot_id)
     FROM jobs source_job
     JOIN phase_resource_plan_slots plan_slot
       ON plan_slot.phase_resource_plan_job_id = source_job.phase_resource_plan_job_id
     WHERE source_job.id = ANY(NEW.source_job_ids))
    IS DISTINCT FROM
    (SELECT array_agg(plan_slot.fulfilment_slot_id ORDER BY plan_slot.fulfilment_slot_id)
     FROM shipment_plan_fulfilment_slots plan_slot
     WHERE plan_slot.shipment_plan_id = NEW.shipment_plan_id)
    OR EXISTS (
      SELECT 1 FROM jobs source_job
      WHERE source_job.id = ANY(NEW.source_job_ids)
        AND (source_job.status NOT IN ('HANDED_OVER', 'SETTLED')
          OR EXISTS (SELECT 1 FROM jobs successor
            WHERE successor.replaces_job_id = source_job.id)))
    OR (SELECT array_agg(resolution.fulfilment_slot_id ORDER BY resolution.fulfilment_slot_id)
        FROM claim_slot_resolutions resolution
        WHERE resolution.claim_id = NEW.claim_id AND resolution.status = 'PENDING')
      IS DISTINCT FROM
      (SELECT array_agg(plan_slot.fulfilment_slot_id ORDER BY plan_slot.fulfilment_slot_id)
        FROM shipment_plan_fulfilment_slots plan_slot
        WHERE plan_slot.shipment_plan_id = NEW.shipment_plan_id)
    OR (
      WITH RECURSIVE lineage AS (
        SELECT shipment.id, shipment.replaces_shipment_id
        FROM shipments shipment WHERE shipment.id = NEW.predecessor_shipment_id
        UNION
        SELECT parent.id, parent.replaces_shipment_id
        FROM shipments parent JOIN lineage ON parent.id = lineage.replaces_shipment_id
      )
      SELECT count(*) FROM jobs source_job
      JOIN job_shipment_assignments assignment ON assignment.job_id = source_job.id
      WHERE source_job.id = ANY(NEW.source_job_ids)
        AND assignment.shipment_id IN (SELECT id FROM lineage)
    ) <> cardinality(NEW.source_job_ids)
  ) THEN
    RAISE EXCEPTION 'claim recovery sources do not cover the exact parcel'
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_preparation_sources_scope_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER recovery_preparation_insert_guard
BEFORE INSERT ON recovery_candidate_preparations
FOR EACH ROW EXECUTE FUNCTION taven_validate_recovery_preparation_insert();

CREATE FUNCTION taven_validate_recovery_dispatch_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent recovery_candidate_preparations%ROWTYPE;
  message outbox_messages%ROWTYPE;
  source_geometry uuid;
  source_config uuid;
  source_quantity integer;
  source_parts_per_plate integer;
  source_machine uuid;
  source_profile uuid;
  source_calibration uuid;
  source_inventory uuid;
  source_arrangement uuid;
  source_payload jsonb;
  source_file uuid;
  source_content text;
  source_geometry_hash text;
  source_item_count integer;
BEGIN
  SELECT * INTO parent FROM recovery_candidate_preparations WHERE id = NEW.preparation_id;
  SELECT * INTO message FROM outbox_messages WHERE id = NEW.outbox_message_id;
  SELECT candidate.model_geometry_id, candidate.print_config_revision_id,
         candidate.quantity, candidate.parts_per_plate,
         candidate.machine_id, candidate.machine_profile_id,
         candidate.machine_calibration_id, candidate.inventory_id,
         candidate.arrangement_revision_id
    INTO source_geometry, source_config, source_quantity,
         source_parts_per_plate, source_machine, source_profile,
         source_calibration, source_inventory, source_arrangement
    FROM jobs job
    JOIN phase_resource_plan_jobs plan_job ON plan_job.id = job.phase_resource_plan_job_id
    JOIN candidate_resource_estimates candidate ON candidate.id = plan_job.candidate_resource_estimate_id
    WHERE job.id = NEW.source_job_id;
  SELECT source_message.payload, item.source_model_file_id,
         source.content_hash, geometry.geometry_hash
    INTO source_payload, source_file, source_content, source_geometry_hash
    FROM jobs job
    JOIN phase_resource_plan_jobs plan_job ON plan_job.id = job.phase_resource_plan_job_id
    JOIN candidate_resource_estimates candidate ON candidate.id = plan_job.candidate_resource_estimate_id
    JOIN candidate_estimate_terminal_results source_terminal
      ON source_terminal.candidate_resource_estimate_id = candidate.id
     AND source_terminal.outcome = 'SUCCEEDED'
    JOIN outbox_messages source_message ON source_message.id = source_terminal.outbox_message_id
    JOIN phase_resource_plan_slots plan_slot ON plan_slot.phase_resource_plan_job_id = plan_job.id
    JOIN fulfilment_slots slot ON slot.id = plan_slot.fulfilment_slot_id
    JOIN order_items item ON item.id = slot.order_item_id
    JOIN model_geometries geometry ON geometry.id = item.model_geometry_id
    JOIN model_files source ON source.id = item.source_model_file_id
    WHERE job.id = NEW.source_job_id
    ORDER BY slot.order_item_id LIMIT 1;
  SELECT count(DISTINCT slot.order_item_id) INTO source_item_count
    FROM jobs job
    JOIN phase_resource_plan_slots plan_slot
      ON plan_slot.phase_resource_plan_job_id = job.phase_resource_plan_job_id
    JOIN fulfilment_slots slot ON slot.id = plan_slot.fulfilment_slot_id
    WHERE job.id = NEW.source_job_id;
  IF source_payload IS NULL OR NOT (NEW.source_job_id = ANY(parent.source_job_ids))
     OR source_item_count IS DISTINCT FROM 1
     OR NEW.source_fingerprint IS DISTINCT FROM taven_recovery_source_fingerprint(NEW.source_job_id)
     OR message.message_type IS DISTINCT FROM 'slicing.candidate-estimate.requested'
     OR message.aggregate_type IS DISTINCT FROM 'CandidateEstimateDispatch'
     OR message.aggregate_id IS DISTINCT FROM NEW.dispatch_job_id
     OR message.payload #>> '{job,jobId}' IS DISTINCT FROM NEW.dispatch_job_id::text
     OR message.payload #>> '{job,correlationId}' IS DISTINCT FROM NEW.preparation_id::text
     OR message.payload #>> '{nodeId}' IS DISTINCT FROM NEW.node_id::text
     OR message.payload #>> '{job,input,shipmentPlanId}' IS DISTINCT FROM NEW.shipment_plan_id::text
     OR message.payload #>> '{job,input,geometry,modelGeometryId}' IS DISTINCT FROM source_geometry::text
     OR source_payload #>> '{job,input,geometry,sourceModelFileId}' IS DISTINCT FROM source_file::text
     OR source_payload #>> '{job,input,geometry,sourceContentSha256}' IS DISTINCT FROM source_content
     OR source_payload #>> '{job,input,geometry,geometrySha256}' IS DISTINCT FROM source_geometry_hash
     OR source_payload #>> '{nodeId}' IS DISTINCT FROM parent.node_id::text
     OR source_payload #>> '{inventoryId}' IS DISTINCT FROM source_inventory::text
     OR source_payload #>> '{job,input,machineId}' IS DISTINCT FROM source_machine::text
     OR source_payload #>> '{job,input,machineProfile,revisionId}' IS DISTINCT FROM source_profile::text
     OR source_payload #>> '{job,input,machineCalibration,revisionId}' IS DISTINCT FROM source_calibration::text
     OR source_payload #>> '{job,input,arrangementRevision,revisionId}' IS DISTINCT FROM source_arrangement::text
     OR (source_payload #>> '{job,input,partsPerPlate}')::integer IS DISTINCT FROM source_parts_per_plate
     OR source_payload #>> '{job,input,printConfig,revisionId}' IS DISTINCT FROM source_config::text
     OR source_payload #>> '{job,input,shipmentPlanId}' IS DISTINCT FROM parent.shipment_plan_id::text
     OR (source_payload #>> '{job,input,quantity}')::integer IS DISTINCT FROM source_quantity
     OR message.payload #>> '{job,input,geometry,sourceModelFileId}' IS DISTINCT FROM source_file::text
     OR message.payload #>> '{job,input,geometry,sourceContentSha256}' IS DISTINCT FROM source_content
     OR message.payload #>> '{job,input,geometry,geometrySha256}' IS DISTINCT FROM source_geometry_hash
     OR message.payload #> '{job,input,geometry,bodyIds}' IS DISTINCT FROM source_payload #> '{job,input,geometry,bodyIds}'
     OR message.payload #>> '{job,input,geometry,selectionSha256}' IS DISTINCT FROM source_payload #>> '{job,input,geometry,selectionSha256}'
     OR message.payload #>> '{job,input,printConfig,revisionId}' IS DISTINCT FROM source_config::text
     OR (message.payload #>> '{job,input,quantity}')::integer IS DISTINCT FROM source_quantity THEN
    RAISE EXCEPTION 'recovery dispatch provenance is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_dispatch_provenance_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER recovery_dispatch_insert_guard
BEFORE INSERT ON recovery_candidate_dispatches
FOR EACH ROW EXECUTE FUNCTION taven_validate_recovery_dispatch_insert();

CREATE FUNCTION taven_recovery_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'recovery preparation history is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'recovery_preparation_immutable_check';
END;
$$;

CREATE TRIGGER recovery_preparation_immutable
BEFORE UPDATE OR DELETE ON recovery_candidate_preparations
FOR EACH ROW EXECUTE FUNCTION taven_recovery_append_only();
CREATE TRIGGER recovery_dispatch_immutable
BEFORE UPDATE OR DELETE ON recovery_candidate_dispatches
FOR EACH ROW EXECUTE FUNCTION taven_recovery_append_only();

-- A fresh replacement Job must use a successful candidate from the latest
-- immutable preparation for its exact request or LOST predecessor.
CREATE FUNCTION taven_validate_fresh_recovery_job() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request replacement_requests%ROWTYPE;
  selected_candidate_id uuid;
  matching_count integer;
BEGIN
  IF NEW.replaces_job_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO request FROM replacement_requests WHERE replacement_job_id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fresh replacement Job needs its completed request'
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_job_provenance_check';
  END IF;
  SELECT candidate_resource_estimate_id INTO selected_candidate_id
    FROM phase_resource_plan_jobs WHERE id = NEW.phase_resource_plan_job_id;
  SELECT count(*) INTO matching_count
  FROM recovery_candidate_preparations preparation
  JOIN recovery_candidate_dispatches dispatch ON dispatch.preparation_id = preparation.id
  JOIN candidate_estimate_terminal_results terminal ON terminal.outbox_message_id = dispatch.outbox_message_id
  JOIN candidate_resource_estimates candidate ON candidate.id = terminal.candidate_resource_estimate_id
  WHERE dispatch.source_job_id = NEW.replaces_job_id
    AND dispatch.source_fingerprint = taven_recovery_source_fingerprint(NEW.replaces_job_id)
    AND terminal.outcome = 'SUCCEEDED'
    AND candidate.id = selected_candidate_id
    AND (
      SELECT array_agg(slot.fulfilment_slot_id ORDER BY slot.fulfilment_slot_id)
      FROM phase_resource_plan_slots slot
      WHERE slot.phase_resource_plan_job_id = NEW.phase_resource_plan_job_id
    ) = (
      SELECT array_agg(slot.fulfilment_slot_id ORDER BY slot.fulfilment_slot_id)
      FROM jobs source_job
      JOIN phase_resource_plan_slots slot
        ON slot.phase_resource_plan_job_id = source_job.phase_resource_plan_job_id
      WHERE source_job.id = NEW.replaces_job_id
    )
    AND candidate.calculated_at >= preparation.requested_at
    AND preparation.order_id = NEW.order_id AND preparation.node_id = NEW.node_id
    AND preparation.order_phase_id = NEW.order_phase_id
    AND preparation.shipment_plan_id = NEW.shipment_plan_id
    AND (
      (request.claim_id IS NULL AND preparation.kind = 'JOB_REPLACEMENT'
        AND preparation.target_id = NEW.replaces_job_id
        AND preparation.replacement_request_id = request.id)
      OR (request.claim_id IS NOT NULL AND preparation.kind = 'LOST_CLAIM_REPRINT'
        AND preparation.claim_id = request.claim_id
        AND preparation.incident_evidence_id = (
          SELECT selected.id FROM shipment_provider_events selected
          WHERE selected.shipment_id = preparation.predecessor_shipment_id
            AND selected.kind = 'LOST'
          ORDER BY selected.occurred_at DESC, selected.id DESC LIMIT 1)
        AND preparation.predecessor_shipment_id = (
          SELECT replaces_shipment_id FROM shipments WHERE id = (
            SELECT replacement_shipment_id FROM claim_slot_resolutions
            WHERE replacement_request_id = request.id LIMIT 1)) )
    )
    AND preparation.generation = (
      SELECT max(current_preparation.generation)
      FROM recovery_candidate_preparations current_preparation
      WHERE current_preparation.kind = preparation.kind
        AND current_preparation.target_id = preparation.target_id
    );
  IF matching_count <> 1 THEN
    RAISE EXCEPTION 'fresh replacement Job has no exact successful preparation'
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_job_provenance_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER recovery_job_provenance_insert
AFTER INSERT ON jobs DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION taven_validate_fresh_recovery_job();

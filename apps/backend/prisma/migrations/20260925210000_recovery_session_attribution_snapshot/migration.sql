-- Existing preparations predate versioned authentication evidence. They keep
-- null metadata; the insert guard below populates every new row from locked
-- authentication facts. No session FK is added, so normal purge can proceed.
ALTER TABLE recovery_candidate_preparations
  ADD COLUMN operator_session_snapshot JSONB;

ALTER TABLE recovery_candidate_preparations
  ADD CONSTRAINT recovery_preparation_operator_session_snapshot_shape_check CHECK (
    operator_session_snapshot IS NULL OR (
      jsonb_typeof(operator_session_snapshot) = 'object'
      AND operator_session_snapshot = jsonb_build_object(
        'schemaVersion', operator_session_snapshot->'schemaVersion',
        'authenticationMethod', operator_session_snapshot->'authenticationMethod',
        'credentialVersion', operator_session_snapshot->'credentialVersion',
        'sessionCreatedAt', operator_session_snapshot->'sessionCreatedAt',
        'validatedAt', operator_session_snapshot->'validatedAt')
      AND operator_session_snapshot->'schemaVersion' = '1'::jsonb
      AND jsonb_typeof(operator_session_snapshot->'authenticationMethod') = 'string'
      AND operator_session_snapshot->>'authenticationMethod' IN ('GITHUB', 'DEVELOPMENT_PASSWORD')
      AND jsonb_typeof(operator_session_snapshot->'credentialVersion') = 'number'
      AND operator_session_snapshot->>'credentialVersion' ~ '^[1-9][0-9]*$'
      AND length(operator_session_snapshot->>'credentialVersion') <= 10
      AND jsonb_typeof(operator_session_snapshot->'sessionCreatedAt') = 'string'
      AND operator_session_snapshot->>'sessionCreatedAt' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
      AND jsonb_typeof(operator_session_snapshot->'validatedAt') = 'string'
      AND operator_session_snapshot->>'validatedAt' = to_char(requested_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  );

CREATE OR REPLACE FUNCTION taven_validate_recovery_preparation_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_count integer;
  locked_operator operator_identities%ROWTYPE;
  locked_session operator_sessions%ROWTYPE;
  decision_at timestamptz(3);
  canonical_snapshot jsonb;
BEGIN
  -- Match the application order lock before assigning an immutable generation.
  PERFORM 1 FROM orders WHERE id = NEW.order_id FOR UPDATE;
  IF NEW.generation IS DISTINCT FROM
     COALESCE((SELECT max(generation) FROM recovery_candidate_preparations
               WHERE kind = NEW.kind AND target_id = NEW.target_id), 0) + 1 THEN
    RAISE EXCEPTION 'recovery preparation generation is not sequential'
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_preparation_generation_sequence_check';
  END IF;
  -- Authentication writers lock identity before session. Keep that order to
  -- avoid a reset/revoke deadlock, and retain both locks until transaction end.
  SELECT * INTO locked_operator FROM operator_identities
    WHERE id = NEW.operator_id FOR SHARE;
  SELECT * INTO locked_session FROM operator_sessions
    WHERE id = NEW.operator_session_id FOR SHARE;
  -- A lock wait can cross expiry or revocation. Use one post-lock DB instant for
  -- both the validity decision and immutable command-time attribution.
  decision_at := clock_timestamp();
  NEW.requested_at := decision_at;
  IF locked_operator.id IS NULL OR locked_session.id IS NULL
     OR locked_session.operator_id IS DISTINCT FROM locked_operator.id
     OR NOT locked_operator.active
     OR locked_session.revoked_at IS NOT NULL
     OR locked_session.absolute_expires_at <= decision_at
     OR locked_session.last_seen_at + interval '30 minutes' <= decision_at
     OR locked_session.created_at > decision_at
     OR locked_session.credential_version IS DISTINCT FROM locked_operator.credential_version
     OR locked_session.credential_version <= 0 THEN
    RAISE EXCEPTION 'recovery preparation operator session is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_preparation_operator_session_check';
  END IF;
  canonical_snapshot := jsonb_build_object(
    'schemaVersion', 1,
    'authenticationMethod', locked_session.authentication_method::text,
    'credentialVersion', locked_session.credential_version,
    'sessionCreatedAt', to_char(locked_session.created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'validatedAt', to_char(NEW.requested_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  IF NEW.operator_session_snapshot IS NOT NULL
     AND NEW.operator_session_snapshot IS DISTINCT FROM canonical_snapshot THEN
    RAISE EXCEPTION 'recovery preparation operator session snapshot conflicts with authentication facts'
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_preparation_operator_session_snapshot_check';
  END IF;
  NEW.operator_session_snapshot := canonical_snapshot;
  IF NOT EXISTS (
    SELECT 1 FROM idempotency_records record
    WHERE record.id = NEW.idempotency_record_id
      AND record.namespace = 'recovery:' || NEW.order_id::text || ':' ||
        left(encode(digest(format('{"kind":%s,"targetId":%s}',
          to_json(NEW.kind::text)::text, to_json(NEW.target_id)::text),
          'sha256'), 'hex'), 24)
      AND record.request_fingerprint = encode(digest(format(
        '{"kind":%s,"orderId":%s,"targetId":%s,"expectedId":%s,"reason":%s}',
        to_json(NEW.kind::text)::text, to_json(NEW.order_id)::text,
        to_json(NEW.target_id)::text,
        to_json(CASE WHEN NEW.kind = 'JOB_REPLACEMENT'
          THEN NEW.replacement_request_id ELSE NEW.predecessor_shipment_id END)::text,
        to_json(NEW.reason)::text), 'sha256'), 'hex')
      AND record.generation = 1
      AND record.status = 'PROCESSING'
      AND record.response_status_code IS NULL AND record.response_body IS NULL
      AND record.expires_at >= '9999-12-31 00:00:00+00'::timestamptz
  ) THEN
    RAISE EXCEPTION 'recovery preparation idempotency record is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_preparation_idempotency_check';
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
        AND NOT EXISTS (
          SELECT 1 FROM refund_transactions refund WHERE refund.claim_id = claim.id)
        AND NOT EXISTS (
          SELECT 1 FROM price_adjustments adjustment WHERE adjustment.claim_id = claim.id)
        AND NOT EXISTS (
          SELECT 1 FROM shipment_plan_fulfilment_slots plan_slot
          JOIN fulfilment_slots slot ON slot.id = plan_slot.fulfilment_slot_id
          WHERE plan_slot.shipment_plan_id = NEW.shipment_plan_id
            AND (slot.order_id IS DISTINCT FROM NEW.order_id
              OR slot.outcome IS DISTINCT FROM 'PENDING'))
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
                  OR resolution.status IS DISTINCT FROM 'PENDING'
                  OR (predecessor.reprint_claim_id IS NOT DISTINCT FROM claim.id
                    AND resolution.replacement_request_id IS NULL)
                  OR (predecessor.reprint_claim_id IS DISTINCT FROM claim.id
                    AND resolution.replacement_request_id IS NOT NULL))))
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

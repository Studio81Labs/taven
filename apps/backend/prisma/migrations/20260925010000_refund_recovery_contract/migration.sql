-- V0 supports one replacement per original refund obligation. Lock the
-- complete payment envelope before inspecting the root/child set so even a
-- direct SQL insert cannot race another writer through the empty-child case.
CREATE FUNCTION taven_guard_refund_retry_root()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_payment_id uuid;
    source_parent_id uuid;
BEGIN
    IF NEW."replaces_refund_transaction_id" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT source."payment_id"
    INTO source_payment_id
    FROM "refund_transactions" source
    WHERE source."id" = NEW."replaces_refund_transaction_id";

    IF NOT FOUND OR source_payment_id IS DISTINCT FROM NEW."payment_id" THEN
        RAISE EXCEPTION 'replacement refund must target its exact source Payment'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_retry_root_scope_check';
    END IF;

    PERFORM taven_lock_checkout_payment_envelope(source_payment_id);

    SELECT source."replaces_refund_transaction_id"
    INTO source_parent_id
    FROM "refund_transactions" source
    WHERE source."id" = NEW."replaces_refund_transaction_id"
      AND source."payment_id" = source_payment_id
    FOR UPDATE;

    IF NOT FOUND OR source_parent_id IS NOT NULL THEN
        RAISE EXCEPTION 'a replacement refund cannot be retried again'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_retry_root_only_check';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "refund_transactions" child
        WHERE child."replaces_refund_transaction_id" = NEW."replaces_refund_transaction_id"
    ) THEN
        RAISE EXCEPTION 'a refund obligation permits only one replacement'
            USING ERRCODE = '23514', CONSTRAINT = 'refund_retry_single_child_check';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "refund_0_retry_root_guard"
BEFORE INSERT ON "refund_transactions"
FOR EACH ROW EXECUTE FUNCTION taven_guard_refund_retry_root();

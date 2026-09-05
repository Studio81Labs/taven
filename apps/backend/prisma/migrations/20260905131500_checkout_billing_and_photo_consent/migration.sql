ALTER TABLE "orders"
  ADD COLUMN "photo_publication_consent_granted_at" timestamptz(3),
  ADD COLUMN "photo_publication_consent_revision" varchar(100),
  ADD CONSTRAINT "orders_photo_publication_consent_values_check" CHECK (
    ("photo_publication_consent_granted_at" IS NULL
      AND "photo_publication_consent_revision" IS NULL)
    OR
    ("photo_publication_consent_granted_at" IS NOT NULL
      AND "photo_publication_consent_revision" IS NOT NULL
      AND "photo_publication_consent_revision" =
        btrim("photo_publication_consent_revision")
      AND "photo_publication_consent_revision" ~ '[^[:space:]]')
  );

ALTER TABLE "orders"
  DROP CONSTRAINT "orders_checkout_contact_snapshot_values_check",
  ADD CONSTRAINT "orders_checkout_contact_snapshot_values_check" CHECK (
    "checkout_contact_snapshot" IS NULL
    OR (
      jsonb_typeof("checkout_contact_snapshot") = 'object'
      AND jsonb_typeof("checkout_contact_snapshot" -> 'email') = 'string'
      AND jsonb_typeof("checkout_contact_snapshot" -> 'fullName') = 'string'
      AND "checkout_contact_snapshot" ->> 'email' =
        lower(btrim("checkout_contact_snapshot" ->> 'email'))
      AND "checkout_contact_snapshot" ->> 'email' ~
        '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      AND char_length("checkout_contact_snapshot" ->> 'email') <= 320
      AND "checkout_contact_snapshot" ->> 'fullName' =
        btrim("checkout_contact_snapshot" ->> 'fullName')
      AND "checkout_contact_snapshot" ->> 'fullName' ~ '[^[:space:]]'
      AND char_length("checkout_contact_snapshot" ->> 'fullName') <= 200
      AND (
        NOT ("checkout_contact_snapshot" ? 'billing')
        OR (
          jsonb_typeof("checkout_contact_snapshot" -> 'version') = 'number'
          AND "checkout_contact_snapshot" ->> 'version' = '2'
          AND NOT ("checkout_contact_snapshot" ? 'phone')
          AND jsonb_typeof("checkout_contact_snapshot" -> 'billing') = 'object'
          AND NOT (("checkout_contact_snapshot" -> 'billing') ? 'phone')
          AND jsonb_typeof("checkout_contact_snapshot" #> '{billing,name}') = 'string'
          AND jsonb_typeof("checkout_contact_snapshot" #> '{billing,addressLine1}') = 'string'
          AND jsonb_typeof("checkout_contact_snapshot" #> '{billing,city}') = 'string'
          AND jsonb_typeof("checkout_contact_snapshot" #> '{billing,postalCode}') = 'string'
          AND jsonb_typeof("checkout_contact_snapshot" #> '{billing,countryCode}') = 'string'
          AND "checkout_contact_snapshot" #>> '{billing,name}' =
            btrim("checkout_contact_snapshot" #>> '{billing,name}')
          AND "checkout_contact_snapshot" #>> '{billing,name}' ~ '[^[:space:]]'
          AND char_length("checkout_contact_snapshot" #>> '{billing,name}') <= 200
          AND "checkout_contact_snapshot" #>> '{billing,addressLine1}' =
            btrim("checkout_contact_snapshot" #>> '{billing,addressLine1}')
          AND "checkout_contact_snapshot" #>> '{billing,addressLine1}' ~ '[^[:space:]]'
          AND char_length("checkout_contact_snapshot" #>> '{billing,addressLine1}') <= 200
          AND "checkout_contact_snapshot" #>> '{billing,city}' =
            btrim("checkout_contact_snapshot" #>> '{billing,city}')
          AND "checkout_contact_snapshot" #>> '{billing,city}' ~ '[^[:space:]]'
          AND char_length("checkout_contact_snapshot" #>> '{billing,city}') <= 100
          AND "checkout_contact_snapshot" #>> '{billing,postalCode}' =
            btrim("checkout_contact_snapshot" #>> '{billing,postalCode}')
          AND "checkout_contact_snapshot" #>> '{billing,postalCode}' ~ '[^[:space:]]'
          AND char_length("checkout_contact_snapshot" #>> '{billing,postalCode}') <= 20
          AND "checkout_contact_snapshot" #>> '{billing,countryCode}' ~ '^[A-Z]{2}$'
          AND (
            NOT (("checkout_contact_snapshot" -> 'billing') ? 'addressLine2')
            OR (
              jsonb_typeof("checkout_contact_snapshot" #> '{billing,addressLine2}') = 'string'
              AND "checkout_contact_snapshot" #>> '{billing,addressLine2}' =
                btrim("checkout_contact_snapshot" #>> '{billing,addressLine2}')
              AND "checkout_contact_snapshot" #>> '{billing,addressLine2}' ~ '[^[:space:]]'
              AND char_length("checkout_contact_snapshot" #>> '{billing,addressLine2}') <= 200
            )
          )
          AND (
            NOT (("checkout_contact_snapshot" -> 'billing') ? 'companyName')
            OR (
              jsonb_typeof("checkout_contact_snapshot" #> '{billing,companyName}') = 'string'
              AND "checkout_contact_snapshot" #>> '{billing,companyName}' =
                btrim("checkout_contact_snapshot" #>> '{billing,companyName}')
              AND "checkout_contact_snapshot" #>> '{billing,companyName}' ~ '[^[:space:]]'
              AND char_length("checkout_contact_snapshot" #>> '{billing,companyName}') <= 200
            )
          )
          AND (
            NOT (("checkout_contact_snapshot" -> 'billing') ? 'companyId')
            OR (
              jsonb_typeof("checkout_contact_snapshot" #> '{billing,companyId}') = 'string'
              AND "checkout_contact_snapshot" #>> '{billing,companyId}' =
                btrim("checkout_contact_snapshot" #>> '{billing,companyId}')
              AND "checkout_contact_snapshot" #>> '{billing,companyId}' ~ '[^[:space:]]'
              AND char_length("checkout_contact_snapshot" #>> '{billing,companyId}') <= 50
            )
          )
          AND (
            NOT (("checkout_contact_snapshot" -> 'billing') ? 'vatId')
            OR (
              jsonb_typeof("checkout_contact_snapshot" #> '{billing,vatId}') = 'string'
              AND "checkout_contact_snapshot" #>> '{billing,vatId}' =
                btrim("checkout_contact_snapshot" #>> '{billing,vatId}')
              AND "checkout_contact_snapshot" #>> '{billing,vatId}' ~ '[^[:space:]]'
              AND char_length("checkout_contact_snapshot" #>> '{billing,vatId}') <= 50
            )
          )
        )
      )
    )
  );

DROP TRIGGER "orders_checkout_contact_snapshot_protected" ON "orders";
DROP FUNCTION taven_protect_order_checkout_contact_snapshot();

CREATE FUNCTION taven_protect_order_checkout_contact_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."checkout_contact_snapshot" IS NOT NULL
       OR NEW."accepted_order_price_binding_id" IS NOT NULL
       OR NEW."accepted_terms_revision" IS NOT NULL
       OR NEW."accepted_claim_policy_revision" IS NOT NULL
       OR NEW."withdrawal_exception_acknowledged_at" IS NOT NULL
       OR NEW."photo_publication_consent_granted_at" IS NOT NULL
       OR NEW."photo_publication_consent_revision" IS NOT NULL THEN
      RAISE EXCEPTION 'checkout evidence cannot predate the quoted order'
        USING ERRCODE = '23514',
              CONSTRAINT = 'order_checkout_contact_snapshot_immutable_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."checkout_contact_snapshot" IS NOT DISTINCT FROM OLD."checkout_contact_snapshot"
     AND NEW."accepted_order_price_binding_id" IS NOT DISTINCT FROM OLD."accepted_order_price_binding_id"
     AND NEW."accepted_terms_revision" IS NOT DISTINCT FROM OLD."accepted_terms_revision"
     AND NEW."accepted_claim_policy_revision" IS NOT DISTINCT FROM OLD."accepted_claim_policy_revision"
     AND NEW."withdrawal_exception_acknowledged_at" IS NOT DISTINCT FROM OLD."withdrawal_exception_acknowledged_at"
     AND NEW."photo_publication_consent_granted_at" IS NOT DISTINCT FROM OLD."photo_publication_consent_granted_at"
     AND NEW."photo_publication_consent_revision" IS NOT DISTINCT FROM OLD."photo_publication_consent_revision" THEN
    RETURN NEW;
  END IF;

  IF OLD."checkout_contact_snapshot" IS NOT NULL
     OR OLD."accepted_order_price_binding_id" IS NOT NULL
     OR OLD."accepted_terms_revision" IS NOT NULL
     OR OLD."accepted_claim_policy_revision" IS NOT NULL
     OR OLD."withdrawal_exception_acknowledged_at" IS NOT NULL
     OR OLD."photo_publication_consent_granted_at" IS NOT NULL
     OR OLD."photo_publication_consent_revision" IS NOT NULL
     OR NEW."checkout_contact_snapshot" IS NULL
     OR NEW."checkout_contact_snapshot" ->> 'version' <> '2'
     OR NEW."accepted_order_price_binding_id" IS NULL
     OR NEW."accepted_terms_revision" IS NULL
     OR NEW."accepted_claim_policy_revision" IS NULL
     OR NEW."withdrawal_exception_acknowledged_at" IS NULL
     OR OLD."status" <> 'QUOTED'
     OR NEW."status" <> 'QUOTED'
     OR EXISTS (
       SELECT 1 FROM "payments" payment WHERE payment."order_id" = OLD."id"
     ) THEN
    RAISE EXCEPTION 'checkout evidence is immutable acceptance evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'order_checkout_contact_snapshot_immutable_check';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "orders_checkout_contact_snapshot_protected"
BEFORE INSERT OR UPDATE OF
  "accepted_order_price_binding_id", "accepted_terms_revision",
  "accepted_claim_policy_revision", "withdrawal_exception_acknowledged_at",
  "checkout_contact_snapshot", "photo_publication_consent_granted_at",
  "photo_publication_consent_revision"
ON "orders"
FOR EACH ROW EXECUTE FUNCTION taven_protect_order_checkout_contact_snapshot();

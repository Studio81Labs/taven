-- Run as the staging/production database owner after migrations.
-- Provision the LOGIN and password separately; never commit credentials.
-- Supply the existing dedicated role with psql -v retention_role=ROLE.
GRANT CONNECT ON DATABASE :"DBNAME" TO :"retention_role";
GRANT USAGE ON SCHEMA public TO :"retention_role";
GRANT SELECT, INSERT, UPDATE ON public.object_storage_sweep_cursors TO :"retention_role";
GRANT SELECT, UPDATE, DELETE ON public.retention_deletion_jobs, public.upload_intents,
  public.business_events TO :"retention_role";
GRANT SELECT, UPDATE ON public.model_files, public.photo_assets TO :"retention_role";
GRANT SELECT ON public.model_geometries, public.slice_results TO :"retention_role";

-- Asset triggers execute with the caller's privileges. Claiming a model checks
-- its live capacity horizon; completing deletion propagates only deleted_at.
GRANT SELECT (id, occupancy_slice_result_id, status)
  ON public.production_reservations TO :"retention_role";
GRANT SELECT (production_reservation_id, ends_at, status)
  ON public.capacity_reservations TO :"retention_role";
GRANT UPDATE (deleted_at) ON public.model_geometries TO :"retention_role";

-- Model/photo deletion also checks active orders and claims. Grant only the
-- identity/status/captured-amount columns read by those guards, not unrelated
-- customer/payment payloads or writes to any of these business tables.
GRANT SELECT (id, status) ON public.orders TO :"retention_role";
GRANT SELECT (id, order_id, source_model_file_id)
  ON public.order_items TO :"retention_role";
GRANT SELECT (order_id, captured_amount_minor)
  ON public.payments TO :"retention_role";
GRANT SELECT (id, status) ON public.claims TO :"retention_role";
GRANT SELECT (claim_id, fulfilment_slot_id)
  ON public.claim_slot_resolutions TO :"retention_role";
GRANT SELECT (id, order_item_id) ON public.fulfilment_slots TO :"retention_role";
GRANT SELECT (id, order_id, phase_resource_plan_job_id, qc_photo_asset_id)
  ON public.jobs TO :"retention_role";
GRANT SELECT (phase_resource_plan_job_id, fulfilment_slot_id)
  ON public.phase_resource_plan_slots TO :"retention_role";
GRANT SELECT (order_id, quote_id)
  ON public.individual_order_origins TO :"retention_role";
GRANT SELECT (order_item_id, quote_item_id)
  ON public.individual_order_item_sources TO :"retention_role";
GRANT SELECT (id, quote_id) ON public.quote_items TO :"retention_role";
GRANT SELECT (id, quote_request_id) ON public.quotes TO :"retention_role";

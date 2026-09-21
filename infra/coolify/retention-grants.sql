-- Run as the staging/production database owner after migrations.
-- Provision the LOGIN and password separately; never commit credentials.
-- Supply the existing dedicated role with psql -v retention_role=ROLE.
GRANT CONNECT ON DATABASE :DBNAME TO :"retention_role";
GRANT USAGE ON SCHEMA public TO :"retention_role";
GRANT SELECT, INSERT, UPDATE ON public.object_storage_sweep_cursors TO :"retention_role";
GRANT SELECT, UPDATE, DELETE ON public.retention_deletion_jobs, public.upload_intents,
  public.business_events TO :"retention_role";
GRANT SELECT, UPDATE ON public.model_files, public.photo_assets TO :"retention_role";
GRANT SELECT ON public.model_geometries, public.slice_results TO :"retention_role";

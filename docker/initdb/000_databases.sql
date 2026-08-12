-- Runs once, on first initialisation of an empty data volume.
-- POSTGRES_DB (observatory) is created by the image itself, so there is nothing to do here.
--
-- This previously created a second database for n8n. n8n was removed on 2026-08-09 (D-011).
-- The file is kept as the mount point for future initialisation, and because deleting it would
-- change the compose bind mount for no benefit.
SELECT 'initdb: nothing to create; POSTGRES_DB is provisioned by the image' AS note;

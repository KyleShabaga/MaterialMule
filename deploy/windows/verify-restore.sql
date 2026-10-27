-- Material Mule restore verification (MM-T21). Read-only: safe on production and on a restored copy.
--
-- backup.ps1 runs it against production around each pg_dump and stores the output with the backup
-- (<name>.manifest.json); restore.ps1 runs it against the restored database and compares the two
-- line by line. Run by hand:
--   psql -X -q -A -t -F "|" -v ON_ERROR_STOP=1 -d <database> -f verify-restore.sql
--
-- Each row is "check|value". Keep checks deterministic (ordered, UTC, no now()), and only use
-- tables that exist in every release from the first one, so old backups still verify.

-- Schema version the backup was taken at.
SELECT 'schema.latest_migration', coalesce(max(version), 'none') FROM schema_migration;

-- Row counts: receipts, storage units, summaries, audit events, print jobs (and their context).
SELECT 'count.receipt', count(*) FROM receipt;
SELECT 'count.storage_unit', count(*) FROM storage_unit;
SELECT 'count.storage_unit_hole_summary', count(*) FROM storage_unit_hole_summary;
SELECT 'count.audit_event', count(*) FROM audit_event;
SELECT 'count.print_job', count(*) FROM print_job;
SELECT 'count.print_job_item', count(*) FROM print_job_item;
SELECT 'count.project', count(*) FROM project;
SELECT 'count.test_hole', count(*) FROM test_hole;
SELECT 'count.app_user', count(*) FROM app_user;
SELECT 'count.location', count(*) FROM location;

-- Latest storage unit ID issued per prefix and year, and the counters that issue the next ones
-- (a restored counter behind the latest ID would reissue an ID: never allowed).
SELECT 'latest_id.' || id_prefix || '-' || issued_year, max(readable_id)
  FROM storage_unit
 GROUP BY id_prefix, issued_year
 ORDER BY id_prefix, issued_year;
SELECT 'counter.' || prefix || '-' || year, last_value
  FROM storage_unit_annual_counter
 ORDER BY prefix, year;

-- Audit history: newest event and a fingerprint of every event ID in order.
SELECT 'audit.latest_at',
       coalesce(to_char(max(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'none')
  FROM audit_event;
SELECT 'audit.fingerprint', md5(coalesce(string_agg(id::text, ',' ORDER BY occurred_at, id), ''))
  FROM audit_event;

-- Spot check of five storage units spread across the ID range (first of each fifth): their
-- identity, project, receipt, type, location, status and version must survive unchanged.
SELECT 'unit.' || readable_id,
       md5(concat_ws('|', id, readable_id, project_id, receipt_id, unit_type, holder_kind,
                     current_location_id, status, received_date, version, note))
  FROM (
    SELECT DISTINCT ON (bucket) *
      FROM (SELECT su.*, ntile(5) OVER (ORDER BY readable_id) AS bucket FROM storage_unit su) spread
     ORDER BY bucket, readable_id
  ) sample
 ORDER BY readable_id;

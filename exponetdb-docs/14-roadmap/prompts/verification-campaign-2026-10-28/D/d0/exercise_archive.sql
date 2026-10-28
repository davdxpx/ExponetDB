-- D0 exploratory exercise A: migrations.archive_mirror_rows. Errors are expected output (SQLSTATE shown, VERBOSITY verbose).
\set ON_ERROR_STOP off
\set VERBOSITY verbose
\pset pager off
\o /dev/stderr
\warn '=== A0 baseline: mirror rows per target/generation'
\connect - exdb_worker
SELECT target_id, generation, string_agg(migration_id, ',' ORDER BY migration_id) AS ids FROM migrations.ledger_mirror GROUP BY 1,2 ORDER BY 1,2;

\warn '=== A1 other roles may not execute the function (expect 42501 each)'
\connect - exdb_serve
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1'],'missing');
\connect - exdb_gateway
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1'],'missing');
\connect - exdb_audit_maint
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1'],'missing');

\connect - exdb_worker
\warn '=== A2 refusals (expect EXM01 each, nothing moves): wrong kind (running migration.apply), queued reconcile, needs_attention op, unknown op, NULL op'
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ3','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1'],'missing');
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ4','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1'],'missing');
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ5','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1'],'missing');
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBZZ','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1'],'missing');
SELECT migrations.archive_mirror_rows(NULL,'tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1'],'missing');
\warn '=== A3 cross-target (expect EXM01 both): R2 (plan for T2) naming T1; R1 (plan for T1) naming T2'
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ2','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1'],'missing');
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA2',1,ARRAY['X1'],'missing');
\warn '=== A4 bad reason (EXM01) and NULL reason (expect 23502 and nothing moved)'
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1'],'gone');
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1'],NULL);
SELECT count(*) AS mirror_rows_t1 FROM migrations.ledger_mirror WHERE target_id='tgt_01M61C90YHV706H2B8EW39TBA1';
\warn '=== A5 NULL / empty arrays: expect 0 moved'
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,NULL,'missing') AS null_ids,
       migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY[]::text[],'missing') AS empty_ids,
       migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY[NULL]::text[],'missing') AS null_elem;
\warn '=== A6 huge array (300000 ids that match nothing): time and result'
SELECT clock_timestamp() AS t0 \gset
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,(SELECT array_agg('Z'||g) FROM generate_series(1,300000) g),'missing') AS moved;
SELECT round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz)::numeric, 2) AS seconds_for_300000_ids;

\warn '=== A7 the happy path: R1 archives M2 (the plan would name M2): expect 1'
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M2'],'missing') AS moved;
SELECT migration_id, reason, operation_id, mirror_row->>'checksum' AS checksum_in_row, mirror_row ? 'applied_seq' AS has_row_image FROM migrations.ledger_mirror_history ORDER BY history_id;

\warn '=== A8 what the function does NOT bind to the plan (all expected to succeed = finding): other generation, ids the plan never named, wrong reason label'
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',1,ARRAY['OLD1'],'differs') AS other_generation;
SELECT migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1','M3'],'differs') AS unnamed_ids_and_wrong_reason;
SELECT target_id, generation, count(*) AS mirror_rows_left FROM migrations.ledger_mirror GROUP BY 1,2 ORDER BY 1,2;
SELECT migration_id, generation, reason, operation_id FROM migrations.ledger_mirror_history ORDER BY history_id;

\warn '=== A9 history is append-only for everyone (worker INSERT 42501; owner/superuser UPDATE/DELETE/TRUNCATE rejected by trigger)'
INSERT INTO migrations.ledger_mirror_history (target_id, generation, migration_id, reason, mirror_row, operation_id) VALUES ('tgt_01M61C90YHV706H2B8EW39TBA1',2,'FORGED','missing','{}','op_01M61C90YHV706H2B8EW39TBQ1');
UPDATE migrations.ledger_mirror_history SET reason='differs';
DELETE FROM migrations.ledger_mirror_history;
\connect - exdb_migrate
UPDATE migrations.ledger_mirror_history SET reason='differs';
DELETE FROM migrations.ledger_mirror_history;
TRUNCATE migrations.ledger_mirror_history;
\connect - postgres
UPDATE migrations.ledger_mirror_history SET reason='differs';
DELETE FROM migrations.ledger_mirror_history;
TRUNCATE migrations.ledger_mirror_history;
SELECT count(*) AS history_rows_after_all_attempts FROM migrations.ledger_mirror_history;

\warn '=== A10 the worker and the mirror: DELETE is refused (42501) but UPDATE of any column is granted (finding: rewrite is possible without history)'
\connect - exdb_worker
DELETE FROM migrations.ledger_mirror WHERE target_id='tgt_01M61C90YHV706H2B8EW39TBA2';
UPDATE migrations.ledger_mirror SET checksum='sha256:c1:FORGED' WHERE target_id='tgt_01M61C90YHV706H2B8EW39TBA2' AND migration_id='X1';
UPDATE migrations.ledger_mirror SET generation=99 WHERE target_id='tgt_01M61C90YHV706H2B8EW39TBA2' AND migration_id='X2';
SELECT migration_id, generation, checksum FROM migrations.ledger_mirror WHERE target_id='tgt_01M61C90YHV706H2B8EW39TBA2' ORDER BY 1;
SELECT count(*) AS history_rows_for_t2 FROM migrations.ledger_mirror_history WHERE target_id='tgt_01M61C90YHV706H2B8EW39TBA2';

\warn '=== A11 pg_temp attack surface: worker cannot create temp objects (TEMP revoked from PUBLIC)'
CREATE TEMP TABLE ledger_mirror_history (i int);
CREATE FUNCTION pg_temp.to_jsonb(anyelement) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"evil":true}'::jsonb $$;

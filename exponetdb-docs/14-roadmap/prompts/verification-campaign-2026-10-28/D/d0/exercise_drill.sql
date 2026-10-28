-- D0 exploratory exercise C: backups.record_offline_drill. Clusters K1/K2 own repositories R1/R2 (fixture2).
\set ON_ERROR_STOP off
\set VERBOSITY verbose
\pset pager off
\o /dev/stderr
\set dg 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
\warn '=== C1 who can execute: serve yes; worker, gateway, audit_maint no (expect 42501 x3)'
\connect - exdb_worker
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD0','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','attested',:'dg','n','idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 hour',now()-interval '30 minutes');
\connect - exdb_gateway
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD0','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','attested',:'dg','n','idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 hour',now()-interval '30 minutes');
\connect - exdb_audit_maint
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD0','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','attested',:'dg','n','idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 hour',now()-interval '30 minutes');
\connect - exdb_serve
\warn '=== C2 serve has no right on the table itself (expect 42501 x3: INSERT, UPDATE, DELETE)'
INSERT INTO backups.drills (drill_id, cluster_id, repository_id, selection, mode, outcome, runbook_digest, recorded_by) VALUES ('drl_01M61C90YHV706H2B8EW39TBD0','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','latest','offline_runbook','attested',:'dg','idn_01M61C90YHV706H2B8EW39TBH1');
UPDATE backups.drills SET notes='x';
DELETE FROM backups.drills;
\warn '=== C3 the intended call (expect one row, mode offline_runbook, restore_id NULL, selection latest)'
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD1','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','attested',:'dg','ran the runbook','idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 hour',now()-interval '30 minutes');
SELECT drill_id, cluster_id, restore_id, repository_id, selection, mode, outcome, left(runbook_digest, 14) AS digest, recorded_by, measured_rto_seconds FROM backups.drills ORDER BY created_at;
\warn '=== C4 outcome other than attested/failed (expect EXB06 x2); a failed attestation is fine'
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD2','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','passed',:'dg','n','idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 hour',now());
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD2','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','pending',:'dg','n','idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 hour',now());
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD3','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','failed',:'dg','n','idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 hour',now()-interval '1 minute');
\warn '=== C5 times: future finish, finish before start (expect EXB06 x2); NULL times are accepted'
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD4','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','attested',:'dg','n','idn_01M61C90YHV706H2B8EW39TBH1',now(),now()+interval '1 day');
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD4','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','attested',:'dg','n','idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 minute',now()-interval '1 hour');
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD5','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','attested',:'dg',NULL,'idn_01M61C90YHV706H2B8EW39TBH1',NULL,NULL);
\warn '=== C6 table CHECKs through the function: NULL recorded_by, bad digest, empty and 4001-char notes (expect 23514 x4), duplicate id (23505), unknown cluster (23503)'
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD6','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','attested',:'dg','n',NULL,now()-interval '1 hour',now()-interval '30 minutes');
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD6','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','attested','sha256:zz','n','idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 hour',now()-interval '30 minutes');
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD6','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','attested',:'dg','','idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 hour',now()-interval '30 minutes');
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD6','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','attested',:'dg',repeat('x',4001),'idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 hour',now()-interval '30 minutes');
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD1','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR1','attested',:'dg','n','idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 hour',now()-interval '30 minutes');
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD7','cls_01M61C90YHV706H2B8EW39TBKZ','bkr_01M61C90YHV706H2B8EW39TBR1','attested',:'dg','n','idn_01M61C90YHV706H2B8EW39TBH1',now()-interval '1 hour',now()-interval '30 minutes');
\warn '=== C7 what the function does NOT check (all expected to succeed = finding): repository of ANOTHER cluster; recorded_by of ANY identity (a person who never called)'
SELECT backups.record_offline_drill('drl_01M61C90YHV706H2B8EW39TBD8','cls_01M61C90YHV706H2B8EW39TBK1','bkr_01M61C90YHV706H2B8EW39TBR2','attested',:'dg','forged: cluster one, repository of cluster two','idn_01M61C90YHV706H2B8EW39TBH9',now()-interval '1 hour',now()-interval '30 minutes');
SELECT drill_id, cluster_id, repository_id, outcome, recorded_by, (SELECT cluster_id FROM backups.repositories r WHERE r.repository_id = d.repository_id) AS repository_cluster FROM backups.drills d ORDER BY created_at;
\warn '=== C8 serve cannot change or remove what it recorded (expect 42501 x2) and a drill is append-only for the owner (trigger)'
UPDATE backups.drills SET outcome='failed';
DELETE FROM backups.drills WHERE drill_id='drl_01M61C90YHV706H2B8EW39TBD1';
\connect - exdb_migrate
DELETE FROM backups.drills WHERE drill_id='drl_01M61C90YHV706H2B8EW39TBD1';
\warn '=== C9 the definer is exdb_migrate (not a superuser); pg_temp cannot be abused (serve cannot create temp objects)'
\connect - postgres
SELECT p.proowner::regrole AS owner, r.rolsuper AS owner_is_superuser, r.rolbypassrls AS owner_bypassrls, r.rolcreaterole FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
 WHERE p.proname IN ('record_offline_drill','archive_mirror_rows') ORDER BY p.proname;
\connect - exdb_serve
CREATE TEMP TABLE drills (i int);

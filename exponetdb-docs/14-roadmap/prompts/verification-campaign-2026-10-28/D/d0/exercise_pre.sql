-- D0 exploratory exercise D: the same state machine at the pre-PR #46 head (bundles up to excused-value-digests).
-- Q5/Q6 (applied/error) and a fresh unknown one are in needs_attention.
\set ON_ERROR_STOP off
\set VERBOSITY verbose
\pset pager off
\o /dev/stderr
\warn '=== D0 the new function does not exist before the PR'
SELECT to_regprocedure('operations.recovery_transition_allowed(text,text)') IS NULL AS absent_before_pr;
\warn '=== D1 baseline defect (TC-005): needs_attention -> verification_failed is refused by the frozen guard (expect EXO01)'
\connect - exdb_worker
UPDATE operations.operations SET state='verification_failed', verification_outcome='failed' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ5';
\warn '=== D2 the worker already had a two-step path to the same end state (needs_attention -> verifying -> verification_failed), incl. rewriting unknown to applied'
\connect - exdb_serve
INSERT INTO operations.plans (plan_id, kind, kind_version, action_class, state, decision, plan_hash, content_checksum, policy_version,
  actor_kind, actor_id, client_kind, client_id, target_id, tier, created_at, expires_at)
VALUES ('pln_01M61C90YHV706H2B8EW39TBP9', 'migration.apply', 1, 'high', 'active', 'allow',
  'sha256:' || encode(sha256(convert_to('p9', 'UTF8')), 'hex'), 'sha256:' || encode(sha256(convert_to('cp9', 'UTF8')), 'hex'),
  'sha256:pv1:' || encode(sha256(convert_to('pv', 'UTF8')), 'hex'), 'human', 'idn_01M61C90YHV706H2B8EW39TBH1', 'web', 'cli_01M61C90YHV706H2B8EW39TBC1',
  'tgt_01M61C90YHV706H2B8EW39TBA1', 'nonprod', clock_timestamp(), clock_timestamp() + interval '1 hour');
INSERT INTO operations.operations (operation_id, plan_id, kind, kind_version, state, apply_outcome, verification_outcome, actor_kind, actor_id, client_kind, client_id)
VALUES ('op_01M61C90YHV706H2B8EW39TBQ9', 'pln_01M61C90YHV706H2B8EW39TBP9', 'migration.apply', 1, 'queued', 'not_started', 'pending', 'human', 'idn_01M61C90YHV706H2B8EW39TBH1', 'web', 'cli_01M61C90YHV706H2B8EW39TBC1');
\connect - exdb_worker
UPDATE operations.operations SET state='running', lease_owner='prc_01M61C90YHV706H2B8EW39TBW1', lease_expires_at=clock_timestamp()+interval '1 hour', attempt=1 WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ9';
UPDATE operations.operations SET state='needs_reconciliation', apply_outcome='unknown' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ9';
UPDATE operations.operations SET state='needs_attention' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ9';
UPDATE operations.operations SET state='verifying', apply_outcome='applied', verification_outcome='pending', lease_owner='prc_01M61C90YHV706H2B8EW39TBW1', lease_expires_at=clock_timestamp()+interval '1 hour' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ9';
UPDATE operations.operations SET state='verification_failed', verification_outcome='failed', lease_owner=NULL, lease_expires_at=NULL WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ9';
SELECT operation_id, state, apply_outcome, verification_outcome FROM operations.operations WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ9';

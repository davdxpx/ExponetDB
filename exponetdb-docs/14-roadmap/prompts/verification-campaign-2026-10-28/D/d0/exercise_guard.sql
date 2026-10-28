-- D0 exploratory exercise B: the replaced operations.operation_guard and the one new edge.
-- Fixture state: Q5 (T1) and Q6 (T2) are in needs_attention (applied / error, no lease).
\set ON_ERROR_STOP off
\set VERBOSITY verbose
\pset pager off
\o /dev/stderr
\warn '=== B0 extra fixture: Q7 and Q8 reach needs_attention with apply_outcome unknown (running -> needs_reconciliation -> needs_attention)'
\connect - exdb_serve
INSERT INTO operations.plans (plan_id, kind, kind_version, action_class, state, decision, plan_hash, content_checksum, policy_version,
  actor_kind, actor_id, client_kind, client_id, target_id, tier, created_at, expires_at)
SELECT p.id, 'migration.apply', 1, 'high', 'active', 'allow',
       'sha256:' || encode(sha256(convert_to(p.id, 'UTF8')), 'hex'), 'sha256:' || encode(sha256(convert_to('c' || p.id, 'UTF8')), 'hex'),
       'sha256:pv1:' || encode(sha256(convert_to('pv', 'UTF8')), 'hex'), 'human', 'idn_01M61C90YHV706H2B8EW39TBH1', 'web',
       'cli_01M61C90YHV706H2B8EW39TBC1', 'tgt_01M61C90YHV706H2B8EW39TBA1', 'nonprod', clock_timestamp(), clock_timestamp() + interval '1 hour'
  FROM (VALUES ('pln_01M61C90YHV706H2B8EW39TBP7'), ('pln_01M61C90YHV706H2B8EW39TBP8')) p(id);
INSERT INTO operations.operations (operation_id, plan_id, kind, kind_version, state, apply_outcome, verification_outcome, actor_kind, actor_id, client_kind, client_id)
SELECT o.op, o.pln, 'migration.apply', 1, 'queued', 'not_started', 'pending', 'human', 'idn_01M61C90YHV706H2B8EW39TBH1', 'web', 'cli_01M61C90YHV706H2B8EW39TBC1'
  FROM (VALUES ('op_01M61C90YHV706H2B8EW39TBQ7','pln_01M61C90YHV706H2B8EW39TBP7'), ('op_01M61C90YHV706H2B8EW39TBQ8','pln_01M61C90YHV706H2B8EW39TBP8')) o(op, pln);
\connect - exdb_worker
UPDATE operations.operations SET state='running', lease_owner='prc_01M61C90YHV706H2B8EW39TBW1', lease_expires_at=clock_timestamp()+interval '1 hour', attempt=1
 WHERE operation_id IN ('op_01M61C90YHV706H2B8EW39TBQ7','op_01M61C90YHV706H2B8EW39TBQ8');
UPDATE operations.operations SET state='needs_reconciliation', apply_outcome='unknown'
 WHERE operation_id IN ('op_01M61C90YHV706H2B8EW39TBQ7','op_01M61C90YHV706H2B8EW39TBQ8');
UPDATE operations.operations SET state='needs_attention', lease_owner=NULL, lease_expires_at=NULL
 WHERE operation_id IN ('op_01M61C90YHV706H2B8EW39TBQ7','op_01M61C90YHV706H2B8EW39TBQ8');
SELECT operation_id, state, apply_outcome, verification_outcome, lease_owner FROM operations.operations WHERE state='needs_attention' ORDER BY 1;

\warn '=== B1 serve cannot use the new edge (expect EXO02: serve may only approve or cancel)'
\connect - exdb_serve
UPDATE operations.operations SET state='verification_failed', verification_outcome='failed' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ6';

\connect - exdb_worker
\warn '=== B2 worker, edge without matching outcomes (expect EXO01 outcomes do not match: applied/error is not admitted by verification_failed)'
UPDATE operations.operations SET state='verification_failed' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ6';
\warn '=== B3 worker, no other exit from needs_attention than verifying (all expect EXO01 transition not allowed)'
UPDATE operations.operations SET state='succeeded', verification_outcome='passed' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ6';
UPDATE operations.operations SET state='failed', apply_outcome='not_applied', verification_outcome='not_applicable' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ7';
UPDATE operations.operations SET state='canceled', apply_outcome='not_started', verification_outcome='not_applicable' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ7';
UPDATE operations.operations SET state='queued', apply_outcome='not_started', verification_outcome='pending' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ7';
UPDATE operations.operations SET state='awaiting_approval', apply_outcome='not_started', verification_outcome='pending' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ7';
UPDATE operations.operations SET state='running', apply_outcome='not_started', verification_outcome='pending', lease_owner='prc_01M61C90YHV706H2B8EW39TBW1', lease_expires_at=clock_timestamp()+interval '1 hour' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ7';
UPDATE operations.operations SET state='needs_reconciliation', apply_outcome='unknown', lease_owner='prc_01M61C90YHV706H2B8EW39TBW1', lease_expires_at=clock_timestamp()+interval '1 hour' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ7';
\warn '=== B4 unknown stays unknown: needs_attention -> verification_failed with apply unknown (expect EXO01: verification_failed does not admit unknown)'
UPDATE operations.operations SET state='verification_failed', verification_outcome='failed' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ7';
\warn '=== B5 the engine path (supersede.ts): unknown -> partially_applied, verification failed (expect UPDATE 1), lease stays NULL'
UPDATE operations.operations SET state='verification_failed', apply_outcome='partially_applied', verification_outcome='failed' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ7';
\warn '=== B6 the lock: only a finished operation lets the worker delete its lock (RLS). Q5 holds target:T1:schema in needs_attention'
INSERT INTO operations.operation_locks (domain_key, operation_id) VALUES ('target:tgt_01M61C90YHV706H2B8EW39TBA1:schema', 'op_01M61C90YHV706H2B8EW39TBQ5');
DELETE FROM operations.operation_locks WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ5';
UPDATE operations.operations SET state='verification_failed', verification_outcome='failed' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ5';
DELETE FROM operations.operation_locks WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ5';
\warn '=== B7 a verification_failed operation never changes again (expect EXO01 x2)'
UPDATE operations.operations SET state='needs_attention', verification_outcome='error' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ5';
UPDATE operations.operations SET state='verifying', verification_outcome='pending' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ7';
\warn '=== B8 the state of the world'
SELECT operation_id, state, apply_outcome, verification_outcome, lease_owner FROM operations.operations ORDER BY 1;
\warn '=== B9 the grants of the two pure functions and the guard (proacl)'
\connect - postgres
SELECT p.oid::regprocedure AS fn, proowner::regrole AS owner, prosecdef AS definer, proconfig, proacl FROM pg_proc p
 WHERE p.oid IN ('operations.operation_guard()'::regprocedure, 'operations.recovery_transition_allowed(text,text)'::regprocedure, 'operations.transition_allowed(text,text)'::regprocedure) ORDER BY 1;
SELECT NOT has_function_privilege('public','operations.recovery_transition_allowed(text,text)','EXECUTE') AS public_cannot_execute,
       has_function_privilege('exdb_gateway','operations.recovery_transition_allowed(text,text)','EXECUTE') AS gateway_can_execute,
       has_function_privilege('exdb_audit_maint','operations.recovery_transition_allowed(text,text)','EXECUTE') AS audit_maint_can_execute;

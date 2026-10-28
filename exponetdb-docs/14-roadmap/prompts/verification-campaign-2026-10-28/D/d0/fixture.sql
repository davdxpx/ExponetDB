-- D0 exploratory fixture for the exercise (run on a database that has all bundles applied).
-- Rows are created through the real role paths (serve inserts plans/operations queued, the worker moves them),
-- except registry.targets (superuser, session_replication_role = replica, only to satisfy the FKs of
-- migrations.ledger_mirror[_history]; the product creates targets through the registry).
\set ON_ERROR_STOP on
\connect - postgres
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO registry.targets (target_id, project_id, environment_id, path, tier, generation, state, created_at,
  created_by_operation_id, state_changed_at, state_changed_by_operation_id)
SELECT t.id, 'prj_01M61C90YHV706H2B8EW39TBPJ', t.env, t.path, 'nonprod', t.gen, 'active', now(),
       'op_01M61C90YHV706H2B8EW39TBA0', now(), 'op_01M61C90YHV706H2B8EW39TBA0'
  FROM (VALUES ('tgt_01M61C90YHV706H2B8EW39TBA1', 'env_01M61C90YHV706H2B8EW39TBE1', 'd0/one/staging', 2),
                ('tgt_01M61C90YHV706H2B8EW39TBA2', 'env_01M61C90YHV706H2B8EW39TBE2', 'd0/two/staging', 1)) t(id, env, path, gen);
COMMIT;

\connect - exdb_serve
-- plans: (plan, kind, target)
INSERT INTO operations.plans (plan_id, kind, kind_version, action_class, state, decision, plan_hash, content_checksum, policy_version,
  actor_kind, actor_id, client_kind, client_id, target_id, tier, created_at, expires_at)
SELECT p.id, p.kind, 1, 'high', 'active', 'allow',
       'sha256:' || encode(sha256(convert_to(p.id, 'UTF8')), 'hex'),
       'sha256:' || encode(sha256(convert_to('c' || p.id, 'UTF8')), 'hex'),
       'sha256:pv1:' || encode(sha256(convert_to('pv', 'UTF8')), 'hex'),
       'human', 'idn_01M61C90YHV706H2B8EW39TBH1', 'web', 'cli_01M61C90YHV706H2B8EW39TBC1', p.target, 'nonprod',
       clock_timestamp(), clock_timestamp() + interval '1 hour'
  FROM (VALUES
    ('pln_01M61C90YHV706H2B8EW39TBP1', 'ledger.reconcile', 'tgt_01M61C90YHV706H2B8EW39TBA1'),
    ('pln_01M61C90YHV706H2B8EW39TBP2', 'ledger.reconcile', 'tgt_01M61C90YHV706H2B8EW39TBA2'),
    ('pln_01M61C90YHV706H2B8EW39TBP3', 'migration.apply',  'tgt_01M61C90YHV706H2B8EW39TBA1'),
    ('pln_01M61C90YHV706H2B8EW39TBP4', 'ledger.reconcile', 'tgt_01M61C90YHV706H2B8EW39TBA1'),
    ('pln_01M61C90YHV706H2B8EW39TBP5', 'migration.apply',  'tgt_01M61C90YHV706H2B8EW39TBA1'),
    ('pln_01M61C90YHV706H2B8EW39TBP6', 'migration.apply',  'tgt_01M61C90YHV706H2B8EW39TBA2')
  ) p(id, kind, target);
INSERT INTO operations.operations (operation_id, plan_id, kind, kind_version, state, apply_outcome, verification_outcome,
  actor_kind, actor_id, client_kind, client_id)
SELECT o.op, o.pln, o.kind, 1, 'queued', 'not_started', 'pending', 'human', 'idn_01M61C90YHV706H2B8EW39TBH1', 'web', 'cli_01M61C90YHV706H2B8EW39TBC1'
  FROM (VALUES
    ('op_01M61C90YHV706H2B8EW39TBQ1', 'pln_01M61C90YHV706H2B8EW39TBP1', 'ledger.reconcile'),  -- R1: T1, will run
    ('op_01M61C90YHV706H2B8EW39TBQ2', 'pln_01M61C90YHV706H2B8EW39TBP2', 'ledger.reconcile'),  -- R2: T2, will run
    ('op_01M61C90YHV706H2B8EW39TBQ3', 'pln_01M61C90YHV706H2B8EW39TBP3', 'migration.apply'),   -- A1: T1, will run (wrong kind)
    ('op_01M61C90YHV706H2B8EW39TBQ4', 'pln_01M61C90YHV706H2B8EW39TBP4', 'ledger.reconcile'),  -- R3: T1, stays queued
    ('op_01M61C90YHV706H2B8EW39TBQ5', 'pln_01M61C90YHV706H2B8EW39TBP5', 'migration.apply'),   -- N1: T1, goes to needs_attention
    ('op_01M61C90YHV706H2B8EW39TBQ6', 'pln_01M61C90YHV706H2B8EW39TBP6', 'migration.apply')    -- N2: T2, goes to needs_attention
  ) o(op, pln, kind);

\connect - exdb_worker
-- the worker claims and runs (queued -> running) under a lease
UPDATE operations.operations SET state = 'running', lease_owner = 'prc_01M61C90YHV706H2B8EW39TBW1',
       lease_expires_at = clock_timestamp() + interval '1 hour', attempt = 1
 WHERE operation_id IN ('op_01M61C90YHV706H2B8EW39TBQ1','op_01M61C90YHV706H2B8EW39TBQ2','op_01M61C90YHV706H2B8EW39TBQ3',
                        'op_01M61C90YHV706H2B8EW39TBQ5','op_01M61C90YHV706H2B8EW39TBQ6');
-- N1, N2: running -> verifying -> needs_attention (applied, verification error), the lease is kept until the worker drops it
UPDATE operations.operations SET state = 'verifying', apply_outcome = 'applied', verification_outcome = 'pending'
 WHERE operation_id IN ('op_01M61C90YHV706H2B8EW39TBQ5','op_01M61C90YHV706H2B8EW39TBQ6');
UPDATE operations.operations SET state = 'needs_attention', verification_outcome = 'error', lease_owner = NULL, lease_expires_at = NULL
 WHERE operation_id IN ('op_01M61C90YHV706H2B8EW39TBQ5','op_01M61C90YHV706H2B8EW39TBQ6');
-- the mirror: T1 generation 2 (current) has three rows, generation 1 one row; T2 generation 1 two rows
INSERT INTO migrations.ledger_mirror (target_id, generation, migration_id, origin, name, checksum, applied_seq, applied_at, operation_id)
SELECT m.t, m.g, m.id, 'exponetdb', 'n-' || m.id, 'sha256:c1:' || m.id, m.seq, now(), 'op_01M61C90YHV706H2B8EW39TBA0'
  FROM (VALUES
    ('tgt_01M61C90YHV706H2B8EW39TBA1', 2, 'M1', 1), ('tgt_01M61C90YHV706H2B8EW39TBA1', 2, 'M2', 2), ('tgt_01M61C90YHV706H2B8EW39TBA1', 2, 'M3', 3),
    ('tgt_01M61C90YHV706H2B8EW39TBA1', 1, 'OLD1', 1),
    ('tgt_01M61C90YHV706H2B8EW39TBA2', 1, 'X1', 1), ('tgt_01M61C90YHV706H2B8EW39TBA2', 1, 'X2', 2)
  ) m(t, g, id, seq);
SELECT 'fixture ready: operations ' || count(*) FROM operations.operations;

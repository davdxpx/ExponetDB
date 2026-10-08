-- OD-28 option (b): scrub what a capability major retired by the Wave 5
-- correction F1 stored before the correction. OWNER ONLY: run it only after
-- the owner decided OD-28 (b) for this installation, never on your own
-- initiative, and only after a backup of the Control Store
-- (node-runbook.md §10). It is irreversible.
--
--   psql "<exdb_migrate URL>" -v ON_ERROR_STOP=1 -f scrub.sql
--
-- As exdb_migrate (the owner of the tables), with the server and the worker
-- stopped. One transaction: it refuses, and changes nothing, while a job of a
-- retired major can still change or a plan it bound can still be accepted or
-- run. Each stored value is replaced by
--
--   {"exdbScrubbed": {"procedure": "od28/v1", "sha256": "<hex>"}}
--
-- where sha256 is over the stored value's text (jsonb text for a job's
-- completion, its arguments and an observation; the stored JCS text for a
-- plan body, so it equals the plan hash). The rows and their identifiers,
-- args hashes, verdicts, states and times stay; the audit chain is not
-- touched; a second run changes nothing. The guards of the three tables are
-- set aside for the updates only and are back on before the commit.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- RETIRED_NODE_CAPABILITIES (packages/contracts); a test keeps the two equal.
-- A setting of this transaction only (the role may not create tables).
SELECT set_config('od28.retired', concat_ws(',',
  'postgres.reload@1', 'postgres.config.inspect@1', 'postgres.config.plan@1',
  'postgres.config.apply@1', 'postgres.hba.inspect@1', 'postgres.hba.apply@1',
  'postgres.roles.inspect@1', 'postgres.roles.plan@1', 'postgres.roles.apply@1',
  'log.inspect@1', 'agent.diagnostics@1'), true);

-- Nothing that can still change is touched.
LOCK TABLE nodes.jobs, nodes.observations, operations.plans, operations.plan_bodies, operations.operations
  IN SHARE ROW EXCLUSIVE MODE;
DO $od28$
BEGIN
  IF EXISTS (SELECT FROM nodes.jobs j
              WHERE j.capability = ANY (string_to_array(current_setting('od28.retired'), ','))
                AND j.state IN ('pending', 'dispatched', 'running')) THEN
    RAISE EXCEPTION 'od28: a job of a retired major is still open; let the worker settle it, then run again';
  END IF;
  IF EXISTS (SELECT FROM operations.plan_bodies b JOIN operations.plans p USING (plan_id)
              WHERE b.body::jsonb -> 'content' -> 'basis' ->> 'capability' = ANY (string_to_array(current_setting('od28.retired'), ','))
                AND (p.state = 'active' AND p.expires_at > clock_timestamp()
                     OR EXISTS (SELECT FROM operations.operations o
                                 WHERE o.plan_id = p.plan_id
                                   AND o.state NOT IN ('succeeded', 'failed', 'verification_failed', 'canceled')))) THEN
    RAISE EXCEPTION 'od28: a plan bound to a retired major can still be accepted or its operation is not finished';
  END IF;
END
$od28$;

ALTER TABLE nodes.jobs DISABLE TRIGGER USER;
ALTER TABLE nodes.observations DISABLE TRIGGER USER;
ALTER TABLE operations.plan_bodies DISABLE TRIGGER USER;

UPDATE nodes.jobs j
   SET completion = jsonb_build_object('exdbScrubbed', jsonb_build_object(
         'procedure', 'od28/v1', 'sha256', encode(sha256(convert_to(j.completion::text, 'UTF8')), 'hex')))
 WHERE j.capability = ANY (string_to_array(current_setting('od28.retired'), ','))
   AND j.completion IS NOT NULL AND NOT j.completion ? 'exdbScrubbed';

UPDATE nodes.jobs j
   SET envelope = jsonb_set(j.envelope, '{args}', jsonb_build_object('exdbScrubbed', jsonb_build_object(
         'procedure', 'od28/v1', 'sha256', encode(sha256(convert_to(coalesce(j.envelope -> 'args', 'null'::jsonb)::text, 'UTF8')), 'hex'))))
 WHERE j.capability = ANY (string_to_array(current_setting('od28.retired'), ','))
   AND NOT coalesce(j.envelope -> 'args' ? 'exdbScrubbed', false);

UPDATE nodes.observations o
   SET result = jsonb_build_object('exdbScrubbed', jsonb_build_object(
         'procedure', 'od28/v1', 'sha256', encode(sha256(convert_to(o.result::text, 'UTF8')), 'hex')))
 WHERE o.capability = ANY (string_to_array(current_setting('od28.retired'), ',')) AND NOT o.result ? 'exdbScrubbed';

UPDATE operations.plan_bodies b
   SET body = jsonb_build_object('exdbScrubbed', jsonb_build_object(
         'procedure', 'od28/v1', 'sha256', encode(sha256(convert_to(b.body, 'UTF8')), 'hex')))::text
 WHERE b.body::jsonb -> 'content' -> 'basis' ->> 'capability' = ANY (string_to_array(current_setting('od28.retired'), ','));

ALTER TABLE nodes.jobs ENABLE TRIGGER USER;
ALTER TABLE nodes.observations ENABLE TRIGGER USER;
ALTER TABLE operations.plan_bodies ENABLE TRIGGER USER;
COMMIT;

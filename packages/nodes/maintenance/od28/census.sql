-- OD-28 census: what a capability major retired by the Wave 5 correction F1
-- stored in the Control Store before the correction, and is not scrubbed.
-- Read only: it changes nothing and needs no decision. Run it as
-- exdb_migrate (node-runbook.md §10):
--
--   psql "<exdb_migrate URL>" -v ON_ERROR_STOP=1 -f census.sql
--
-- The list is RETIRED_NODE_CAPABILITIES (packages/contracts,
-- node-protocol/capabilities.ts); a test keeps the two equal.
WITH retired (capability) AS (
  VALUES ('postgres.reload@1'), ('postgres.restart.plan@1'), ('postgres.config.inspect@1'), ('postgres.config.plan@1'),
         ('postgres.config.apply@1'), ('postgres.hba.inspect@1'), ('postgres.hba.apply@1'),
         ('postgres.roles.inspect@1'), ('postgres.roles.plan@1'), ('postgres.roles.apply@1'),
         ('log.inspect@1'), ('agent.diagnostics@1')
)
SELECT 'nodes.jobs.completion' AS stored, count(*)::int AS rows
  FROM nodes.jobs j
 WHERE j.capability IN (SELECT capability FROM retired)
   AND j.completion IS NOT NULL AND NOT j.completion ? 'exdbScrubbed'
UNION ALL
SELECT 'nodes.jobs.envelope.args', count(*)::int
  FROM nodes.jobs j
 WHERE j.capability IN (SELECT capability FROM retired)
   AND NOT coalesce(j.envelope -> 'args' ? 'exdbScrubbed', false)
UNION ALL
SELECT 'nodes.observations.result', count(*)::int
  FROM nodes.observations o
 WHERE o.capability IN (SELECT capability FROM retired) AND NOT o.result ? 'exdbScrubbed'
UNION ALL
SELECT 'operations.plan_bodies.body', count(*)::int
  FROM operations.plan_bodies b
 WHERE b.body::jsonb -> 'content' -> 'basis' ->> 'capability' IN (SELECT capability FROM retired)
UNION ALL
SELECT 'nodes.jobs open (scrub refuses while > 0)', count(*)::int
  FROM nodes.jobs j
 WHERE j.capability IN (SELECT capability FROM retired) AND j.state IN ('pending', 'dispatched', 'running');

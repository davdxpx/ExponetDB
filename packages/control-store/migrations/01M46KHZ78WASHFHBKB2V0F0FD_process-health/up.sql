-- Process heartbeats (health.md §8): id, role, build, start, last beat.
-- No host names, no user data.
CREATE TABLE control.process_heartbeats (
  process_id    text        PRIMARY KEY CHECK (process_id ~ '^prc_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  role          text        NOT NULL CHECK (role IN ('serve', 'worker', 'gateway')),
  build_version text        NOT NULL CHECK (build_version ~ '^[0-9A-Za-z.+-]{1,64}$'),
  build_commit  text        NOT NULL CHECK (build_commit ~ '^([0-9a-f]{7,40}|unknown)$'),
  started_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at    timestamptz
);
CREATE INDEX process_heartbeats_live ON control.process_heartbeats (role, heartbeat_at DESC) WHERE stopped_at IS NULL;

-- Each login may write only heartbeats of its own role; every runtime role
-- may read all of them (version skew and liveness checks). Only the worker
-- prunes, and only stale rows.
ALTER TABLE control.process_heartbeats ENABLE ROW LEVEL SECURITY;
CREATE POLICY heartbeats_read ON control.process_heartbeats FOR SELECT
  TO exdb_serve, exdb_worker, exdb_gateway USING (true);
CREATE POLICY heartbeats_serve_insert ON control.process_heartbeats FOR INSERT
  TO exdb_serve WITH CHECK (role = 'serve');
CREATE POLICY heartbeats_serve_update ON control.process_heartbeats FOR UPDATE
  TO exdb_serve USING (role = 'serve') WITH CHECK (role = 'serve');
CREATE POLICY heartbeats_worker_insert ON control.process_heartbeats FOR INSERT
  TO exdb_worker WITH CHECK (role = 'worker');
CREATE POLICY heartbeats_worker_update ON control.process_heartbeats FOR UPDATE
  TO exdb_worker USING (role = 'worker') WITH CHECK (role = 'worker');
CREATE POLICY heartbeats_gateway_insert ON control.process_heartbeats FOR INSERT
  TO exdb_gateway WITH CHECK (role = 'gateway');
CREATE POLICY heartbeats_gateway_update ON control.process_heartbeats FOR UPDATE
  TO exdb_gateway USING (role = 'gateway') WITH CHECK (role = 'gateway');
CREATE POLICY heartbeats_worker_prune ON control.process_heartbeats FOR DELETE
  TO exdb_worker
  USING ((stopped_at IS NOT NULL AND stopped_at < clock_timestamp() - interval '1 day')
         OR heartbeat_at < clock_timestamp() - interval '7 days');

GRANT SELECT, INSERT ON control.process_heartbeats TO exdb_serve, exdb_worker, exdb_gateway;
GRANT UPDATE (heartbeat_at, stopped_at) ON control.process_heartbeats TO exdb_serve, exdb_worker, exdb_gateway;
GRANT DELETE ON control.process_heartbeats TO exdb_worker;

-- Leases of the worker's maintenance tasks (one runner per task at a time).
CREATE TABLE control.maintenance_tasks (
  task                 text        PRIMARY KEY CHECK (task ~ '^[a-z][a-z0-9_.]{0,63}$'),
  next_run_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner          text        CHECK (lease_owner ~ '^prc_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  lease_expires_at     timestamptz,
  last_started_at      timestamptz,
  last_finished_at     timestamptz,
  last_outcome         text        CHECK (last_outcome IN ('succeeded', 'failed', 'skipped')),
  last_reason          text        CHECK (last_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  consecutive_failures integer     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

GRANT SELECT, INSERT, UPDATE ON control.maintenance_tasks TO exdb_worker;
GRANT SELECT ON control.maintenance_tasks TO exdb_serve, exdb_gateway;

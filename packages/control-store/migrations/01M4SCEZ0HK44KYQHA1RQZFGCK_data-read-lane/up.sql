-- The data-read lane (ADR-0028 §1). Owner: exdb_migrate. Ciphertext only.
CREATE SCHEMA dataread AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA dataread FROM PUBLIC;
GRANT USAGE ON SCHEMA dataread TO exdb_serve, exdb_worker;

-- A worker that executes data reads: the public half of an X25519 key it holds
-- in memory only; a restart registers a new key and requests sealed to the old
-- one are never opened.
CREATE TABLE dataread.workers (
  worker_id     text        PRIMARY KEY CHECK (worker_id ~ '^prc_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  public_key    bytea       NOT NULL CHECK (octet_length(public_key) = 32),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One data read while it runs: who asked (never a token), the worker it is
-- addressed to, the request and the result sealed with HPKE, the state.
CREATE TABLE dataread.reads (
  query_id         text        PRIMARY KEY CHECK (query_id ~ '^qry_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  kind             text        NOT NULL CHECK (kind IN ('query', 'explain')),
  target_id        text        NOT NULL CHECK (target_id ~ '^tgt_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  identity_id      text        NOT NULL CHECK (identity_id ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  client_id        text        CHECK (client_id ~ '^cli_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  grant_id         text        CHECK (grant_id ~ '^grt_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  caller_class     text        NOT NULL CHECK (caller_class IN ('agent', 'human')),
  worker_id        text        NOT NULL CHECK (worker_id ~ '^prc_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  request_id       text        NOT NULL CHECK (request_id ~ '^req_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  request          bytea       NOT NULL CHECK (octet_length(request) <= 262144),
  result           bytea       CHECK (result IS NULL OR octet_length(result) <= 16777216),
  state            text        NOT NULL DEFAULT 'waiting'
                               CHECK (state IN ('waiting', 'running', 'done', 'failed', 'canceled')),
  error_code       text        CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  cancel_requested boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at      timestamptz NOT NULL,
  claimed_at       timestamptz,
  finished_at      timestamptz,
  CHECK (deadline_at > created_at AND deadline_at <= created_at + interval '5 minutes'),
  CHECK ((state = 'done') = (result IS NOT NULL)),
  CHECK ((state = 'failed') = (error_code IS NOT NULL)),
  CHECK ((state IN ('done', 'failed', 'canceled')) = (finished_at IS NOT NULL))
);
CREATE INDEX reads_waiting ON dataread.reads (worker_id, created_at) WHERE state = 'waiting';
CREATE INDEX reads_open_by_grant ON dataread.reads (grant_id) WHERE state IN ('waiting', 'running');
CREATE INDEX reads_open_by_target ON dataread.reads (target_id) WHERE state IN ('waiting', 'running');
CREATE INDEX reads_by_deadline ON dataread.reads (deadline_at);

-- serve: reads the live workers, submits, cancels, collects and deletes.
GRANT SELECT ON dataread.workers TO exdb_serve;
GRANT SELECT, INSERT, DELETE ON dataread.reads TO exdb_serve;
GRANT UPDATE (cancel_requested) ON dataread.reads TO exdb_serve;
-- worker: registers its key, claims what is addressed to it, writes the
-- sealed result, deletes reads past their deadline.
GRANT SELECT, INSERT, DELETE ON dataread.workers TO exdb_worker;
GRANT UPDATE (heartbeat_at) ON dataread.workers TO exdb_worker;
GRANT SELECT, DELETE ON dataread.reads TO exdb_worker;
GRANT UPDATE (state, result, error_code, claimed_at, finished_at) ON dataread.reads TO exdb_worker;

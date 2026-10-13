-- The last use of a grant (Wave 7 order §16): the minute and the class only.
CREATE TABLE oauth.grant_last_use (
  grant_id     text        PRIMARY KEY REFERENCES oauth.grants (grant_id) ON DELETE CASCADE,
  last_used_at timestamptz NOT NULL CHECK (last_used_at = date_trunc('minute', last_used_at)),
  use_class    text        NOT NULL CHECK (use_class IN ('read', 'plan', 'apply', 'data', 'rest'))
);

-- serve records uses (an upsert at most once a minute) and reads them; nobody deletes.
GRANT SELECT, INSERT ON oauth.grant_last_use TO exdb_serve;
GRANT UPDATE (last_used_at, use_class) ON oauth.grant_last_use TO exdb_serve;

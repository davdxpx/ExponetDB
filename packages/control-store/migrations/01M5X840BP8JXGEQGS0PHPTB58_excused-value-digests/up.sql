-- OD-56 (a): keyed digests of excused values (legacy-import.md §2, steps 5 and 7).
-- Owner: exdb_migrate. No value and no key material is stored here: the key is a
-- worker secret (envelope-encrypted in schema secrets), the digests are HMACs.

-- The installation's excused-value key: one secret, created by the worker on first use.
CREATE TABLE migrations.excused_value_key (
  singleton  boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  secret_id  text        NOT NULL UNIQUE CHECK (secret_id ~ '^sec_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- A report analyzed with digests, and the key version it used (NULL: no failure of a
-- value needed one). A report without a row was analyzed before this bundle.
CREATE TABLE migrations.import_value_keys (
  report_id   text        PRIMARY KEY REFERENCES migrations.import_reports (report_id) ON DELETE RESTRICT,
  key_ref     text        CHECK (key_ref ~ '^sec_[0-7][0-9A-HJKMNP-TV-Z]{25}:[1-9][0-9]{0,8}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Per failing expectation of a value (the failure's identity as a SHA-256 of its file,
-- statement, kind, object and aspects), the keyed digest of the observed value.
CREATE TABLE migrations.import_value_digests (
  report_id text NOT NULL REFERENCES migrations.import_value_keys (report_id) ON DELETE RESTRICT,
  item_id   integer NOT NULL,
  failure   text NOT NULL CHECK (failure ~ '^[0-9a-f]{64}$'),
  digest    text NOT NULL CHECK (digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (report_id, item_id, failure),
  FOREIGN KEY (report_id, item_id) REFERENCES migrations.import_items (report_id, item_id) ON DELETE RESTRICT
);

-- Written once by the worker; never changed, never removed.
CREATE FUNCTION migrations.excused_value_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  RAISE EXCEPTION 'excused-value keys and digests are written once and never change' USING ERRCODE = 'EXO12';
END
$fn$;
REVOKE ALL ON FUNCTION migrations.excused_value_guard() FROM PUBLIC;
CREATE TRIGGER excused_value_key_guard BEFORE UPDATE OR DELETE ON migrations.excused_value_key
  FOR EACH ROW EXECUTE FUNCTION migrations.excused_value_guard();
CREATE TRIGGER import_value_keys_guard BEFORE UPDATE OR DELETE ON migrations.import_value_keys
  FOR EACH ROW EXECUTE FUNCTION migrations.excused_value_guard();
CREATE TRIGGER import_value_digests_guard BEFORE UPDATE OR DELETE ON migrations.import_value_digests
  FOR EACH ROW EXECUTE FUNCTION migrations.excused_value_guard();

REVOKE ALL ON migrations.excused_value_key, migrations.import_value_keys,
              migrations.import_value_digests FROM PUBLIC;
GRANT SELECT, INSERT ON migrations.excused_value_key, migrations.import_value_keys,
                        migrations.import_value_digests TO exdb_worker;
-- serve plans baselines: it reads whether (and with which key) a report recorded digests.
GRANT SELECT ON migrations.import_value_keys TO exdb_serve;

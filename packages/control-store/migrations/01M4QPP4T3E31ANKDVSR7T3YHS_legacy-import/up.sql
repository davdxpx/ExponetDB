-- Legacy import reports (legacy-import.md §2). Owner: exdb_migrate.
-- serve records the analysis request (the report, pending, and the exact
-- legacy files) and a person's decisions on items; the worker replays the
-- files on the scratch target, writes the items and the report's results,
-- and marks the report baselined. The target's ledger stays the truth of
-- what was imported; the report is the reviewed evidence behind it.
CREATE TABLE migrations.import_reports (
  report_id             text        PRIMARY KEY CHECK (report_id ~ '^imr_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  target_id             text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  project_id            text        NOT NULL REFERENCES registry.projects (project_id) ON DELETE RESTRICT,
  scratch_target_id     text        NOT NULL REFERENCES registry.targets (target_id) ON DELETE RESTRICT,
  baseline_id           text        NOT NULL CHECK (baseline_id ~ '^baseline:[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(baseline_id) <= 73),
  hints                 jsonb       NOT NULL CHECK (jsonb_typeof(hints) = 'object'),
  state                 text        NOT NULL DEFAULT 'pending'
                                    CHECK (state IN ('pending', 'incomplete', 'open', 'baselined', 'superseded')),
  fingerprint           text        CHECK (fingerprint ~ '^fp1:1[6-9]:[0-9a-f]{64}$'),
  replay_fingerprint    text        CHECK (replay_fingerprint ~ '^fp1:1[6-9]:[0-9a-f]{64}$'),
  incomplete_reason     text        CHECK (incomplete_reason IS NULL OR char_length(incomplete_reason) <= 200),
  plan_id               text        CHECK (plan_id ~ '^pln_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  operation_id          text        CHECK (operation_id ~ '^op_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  baseline_operation_id text        CHECK (baseline_operation_id ~ '^op_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by            text        NOT NULL CHECK (created_by ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  analyzed_at           timestamptz,
  baselined_at          timestamptz,
  CHECK (scratch_target_id <> target_id)
);
CREATE INDEX import_reports_by_target ON migrations.import_reports (target_id, created_at);

CREATE TABLE migrations.import_files (
  report_id      text    NOT NULL REFERENCES migrations.import_reports (report_id) ON DELETE RESTRICT,
  position       integer NOT NULL CHECK (position BETWEEN 0 AND 999),
  stem           text    NOT NULL CHECK (stem ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,195}$'),
  bytes          bytea   NOT NULL CHECK (octet_length(bytes) <= 4194304),
  checksum       text    NOT NULL CHECK (checksum ~ '^sha256:c1:[0-9a-f]{64}$'),
  source_digest  text    NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  bytes_digest   text    NOT NULL CHECK (bytes_digest ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (report_id, position),
  UNIQUE (report_id, stem)
);
CREATE TRIGGER import_files_immutable BEFORE UPDATE OR DELETE ON migrations.import_files
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER import_files_no_truncate BEFORE TRUNCATE ON migrations.import_files
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

CREATE TABLE migrations.import_items (
  report_id           text        NOT NULL REFERENCES migrations.import_reports (report_id) ON DELETE RESTRICT,
  item_id             integer     NOT NULL CHECK (item_id BETWEEN 1 AND 999999),
  kind                text        NOT NULL CHECK (kind IN ('file', 'ledger_entry', 'drift')),
  legacy_id           text        NOT NULL CHECK (char_length(legacy_id) BETWEEN 1 AND 200),
  name                text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  state               text        NOT NULL CHECK (state IN ('recorded_present', 'unrecorded_present', 'recorded_missing',
                                    'unrecorded_missing', 'superseded', 'not_applicable', 'ambiguous')),
  content_digest      text        CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  checksum_provenance text        CHECK (checksum_provenance IN ('legacy_file_at_import', 'legacy_tool_hash',
                                    'legacy_applied_statements', 'unknown')),
  applied_at          timestamptz,
  evidence            jsonb       NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  decision_state      text        CHECK (decision_state IN ('recorded_present', 'unrecorded_present', 'recorded_missing',
                                    'unrecorded_missing', 'superseded', 'not_applicable')),
  decision_note       text        CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 1000),
  decided_at          timestamptz,
  decided_by          text        CHECK (decided_by ~ '^idn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  PRIMARY KEY (report_id, item_id),
  CHECK ((decision_state IS NULL) = (decision_note IS NULL)
     AND (decision_state IS NULL) = (decided_at IS NULL)
     AND (decision_state IS NULL) = (decided_by IS NULL))
);

-- An item's classification never changes; only an open report's decisions do.
CREATE FUNCTION migrations.import_items_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'import items are never deleted' USING ERRCODE = 'EXO12';
  END IF;
  IF (NEW.report_id, NEW.item_id, NEW.kind, NEW.legacy_id, NEW.name, NEW.state, NEW.content_digest,
      NEW.checksum_provenance, NEW.applied_at, NEW.evidence)
     IS DISTINCT FROM
     (OLD.report_id, OLD.item_id, OLD.kind, OLD.legacy_id, OLD.name, OLD.state, OLD.content_digest,
      OLD.checksum_provenance, OLD.applied_at, OLD.evidence)
     OR NOT EXISTS (SELECT 1 FROM migrations.import_reports r
                     WHERE r.report_id = OLD.report_id AND r.state = 'open') THEN
    RAISE EXCEPTION 'only the decision of an item of an open report changes' USING ERRCODE = 'EXO12';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION migrations.import_items_guard() FROM PUBLIC;
CREATE TRIGGER import_items_guard BEFORE UPDATE OR DELETE ON migrations.import_items
  FOR EACH ROW EXECUTE FUNCTION migrations.import_items_guard();
CREATE TRIGGER import_items_no_truncate BEFORE TRUNCATE ON migrations.import_items
  FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change();

GRANT SELECT ON migrations.import_reports, migrations.import_files, migrations.import_items
  TO exdb_serve, exdb_worker;
GRANT INSERT ON migrations.import_reports, migrations.import_files TO exdb_serve;
GRANT UPDATE (decision_state, decision_note, decided_at, decided_by) ON migrations.import_items TO exdb_serve;
GRANT INSERT ON migrations.import_items TO exdb_worker;
GRANT UPDATE (state, fingerprint, replay_fingerprint, incomplete_reason, operation_id, analyzed_at,
              baseline_operation_id, baselined_at)
  ON migrations.import_reports TO exdb_worker;
GRANT UPDATE (plan_id) ON migrations.import_reports TO exdb_serve;

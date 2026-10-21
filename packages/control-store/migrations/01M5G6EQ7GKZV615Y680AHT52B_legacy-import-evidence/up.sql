-- Evidence strength per import item (legacy-import.md §2.3): what the
-- classification relied on, written with the item by the worker.
ALTER TABLE migrations.import_items
  ADD COLUMN evidence_strength text
    CHECK (evidence_strength IN ('strong', 'medium', 'low', 'curated', 'weak'));

-- The global drift of a report is never cut silently (Wave 9 order A3): the
-- report holds at most a fixed number of drift items, records how many
-- exist, and says when it holds fewer.
ALTER TABLE migrations.import_reports
  ADD COLUMN drift_total     integer CHECK (drift_total >= 0),
  ADD COLUMN drift_truncated boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT import_reports_drift_recorded
    CHECK (NOT drift_truncated OR drift_total IS NOT NULL);

-- An item's evidence strength never changes after it was written (the
-- frozen guard of the legacy-import bundle covers the other columns).
CREATE FUNCTION migrations.import_items_evidence_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF NEW.evidence_strength IS DISTINCT FROM OLD.evidence_strength THEN
    RAISE EXCEPTION 'the evidence strength of an import item never changes' USING ERRCODE = 'EXO12';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION migrations.import_items_evidence_guard() FROM PUBLIC;
CREATE TRIGGER import_items_evidence_guard BEFORE UPDATE ON migrations.import_items
  FOR EACH ROW EXECUTE FUNCTION migrations.import_items_evidence_guard();

-- The drift totals are written once, by the worker, while it finishes a
-- pending analysis; afterwards they never change.
CREATE FUNCTION migrations.import_reports_drift_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF (NEW.drift_total, NEW.drift_truncated) IS NOT DISTINCT FROM (OLD.drift_total, OLD.drift_truncated) THEN
    RETURN NEW;
  END IF;
  IF OLD.state <> 'pending' OR OLD.drift_total IS NOT NULL OR OLD.drift_truncated THEN
    RAISE EXCEPTION 'the drift totals of an import report are written once, when its analysis ends'
      USING ERRCODE = 'EXO12';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION migrations.import_reports_drift_guard() FROM PUBLIC;
CREATE TRIGGER import_reports_drift_guard BEFORE UPDATE ON migrations.import_reports
  FOR EACH ROW EXECUTE FUNCTION migrations.import_reports_drift_guard();

GRANT UPDATE (drift_total, drift_truncated) ON migrations.import_reports TO exdb_worker;

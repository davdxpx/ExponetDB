-- The failing expectations of an import item at the analysis (legacy-import.md
-- §2, follow-up 3 F1): what a decision that accepts the item as applied excuses.
ALTER TABLE migrations.import_items
  ADD COLUMN failing jsonb CHECK (failing IS NULL OR jsonb_typeof(failing) = 'array');

-- Written with the item by the worker; it never changes afterwards (the frozen
-- guard of the legacy-import bundle covers the other columns).
CREATE FUNCTION migrations.import_items_failing_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF NEW.failing IS DISTINCT FROM OLD.failing THEN
    RAISE EXCEPTION 'the failing expectations of an import item never change' USING ERRCODE = 'EXO12';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION migrations.import_items_failing_guard() FROM PUBLIC;
CREATE TRIGGER import_items_failing_guard BEFORE UPDATE ON migrations.import_items
  FOR EACH ROW EXECUTE FUNCTION migrations.import_items_failing_guard();

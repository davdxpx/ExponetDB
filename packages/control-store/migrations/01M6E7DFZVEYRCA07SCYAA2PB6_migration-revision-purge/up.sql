-- OD-70 (d): never-planned bundle revisions older than 90 days may be purged, by
-- migrations.purge_revisions only. A revision is referenced when the body of any
-- plan of another kind names its migration id (plans keep their bodies for ever),
-- or a target's ledger mirror lists it.
CREATE FUNCTION migrations.revision_referenced(p_migration_id text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT EXISTS (SELECT FROM operations.plan_bodies b JOIN operations.plans p USING (plan_id)
                  WHERE p.kind <> 'migration.revisions.purge'
                    AND strpos(b.body, '"' || p_migration_id || '"') > 0)
      OR EXISTS (SELECT FROM migrations.ledger_mirror m WHERE m.migration_id = p_migration_id)
$fn$;
REVOKE ALL ON FUNCTION migrations.revision_referenced(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION migrations.revision_referenced(text) TO exdb_serve, exdb_worker;

CREATE FUNCTION migrations.revision_purge_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF current_setting('exponetdb.revision_purge', true) IS DISTINCT FROM 'on'
     OR OLD.ingested_at >= clock_timestamp() - interval '90 days'
     OR migrations.revision_referenced(OLD.migration_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXM02',
      MESSAGE = 'bundle revision purge: only a revision no plan references and older than 90 days may go';
  END IF;
  RETURN OLD;
END
$fn$;
REVOKE ALL ON FUNCTION migrations.revision_purge_guard() FROM PUBLIC;

-- The append-only trigger keeps its name; it skips a delete while the purge flag is set, which
-- the guard below then judges. Updates stay refused by a trigger of their own.
DROP TRIGGER bundle_revisions_immutable ON migrations.bundle_revisions;
CREATE TRIGGER bundle_revisions_immutable BEFORE UPDATE OR DELETE ON migrations.bundle_revisions
  FOR EACH ROW WHEN (current_setting('exponetdb.revision_purge', true) IS DISTINCT FROM 'on')
  EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER bundle_revisions_no_update BEFORE UPDATE ON migrations.bundle_revisions
  FOR EACH ROW EXECUTE FUNCTION control.reject_change();
CREATE TRIGGER bundle_revisions_purge_guard BEFORE DELETE ON migrations.bundle_revisions
  FOR EACH ROW EXECUTE FUNCTION migrations.revision_purge_guard();

-- The worker's only way to delete revisions: exactly the keys it names, in the caller's
-- transaction. SHARE ROW EXCLUSIVE on the plans tables waits for plans being written and holds
-- new ones until the purge commits, so the guard sees every plan that could name a revision.
CREATE FUNCTION migrations.purge_revisions(p_project_id text, p_migration_ids text[], p_revisions integer[])
  RETURNS TABLE (purged integer, bytes bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF cardinality(p_migration_ids) IS DISTINCT FROM cardinality(p_revisions) OR cardinality(p_migration_ids) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'EXM02', MESSAGE = 'bundle revision purge: invalid keys';
  END IF;
  LOCK TABLE operations.plans, operations.plan_bodies IN SHARE ROW EXCLUSIVE MODE;
  PERFORM set_config('exponetdb.revision_purge', 'on', true);
  RETURN QUERY
    WITH gone AS (
      DELETE FROM migrations.bundle_revisions r
       USING unnest(p_migration_ids, p_revisions) AS k (migration_id, revision)
       WHERE r.project_id = p_project_id AND r.migration_id = k.migration_id AND r.revision = k.revision
      RETURNING octet_length(r.manifest_yaml) + octet_length(r.up_sql)
                + coalesce(octet_length(r.verify_sql), 0) + coalesce(octet_length(r.down_sql), 0) AS n
    )
    SELECT count(*)::integer, coalesce(sum(n), 0)::bigint FROM gone;
  PERFORM set_config('exponetdb.revision_purge', 'off', true);
END
$fn$;
REVOKE ALL ON FUNCTION migrations.purge_revisions(text, text[], integer[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION migrations.purge_revisions(text, text[], integer[]) TO exdb_worker;

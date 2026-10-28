-- TC-013 (D-09): serve records the attestation of an offline drill. Owner: exdb_migrate.
-- serve has no INSERT on backups.drills (the catalog bundle verifies that it only reads); this
-- function is the one way it writes, and it writes one offline attestation: mode offline_runbook,
-- no restore, the selection the attestation stands for. The table's CHECKs and drill_guard apply.
CREATE FUNCTION backups.record_offline_drill(
  p_drill_id text, p_cluster_id text, p_repository_id text, p_outcome text, p_runbook_digest text,
  p_notes text, p_recorded_by text, p_started_at timestamptz, p_finished_at timestamptz
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF p_outcome NOT IN ('attested', 'failed') THEN
    RAISE EXCEPTION USING ERRCODE = 'EXB06', MESSAGE = 'an offline drill is attested or failed';
  END IF;
  INSERT INTO backups.drills (drill_id, cluster_id, restore_id, repository_id, selection, mode, outcome,
                              runbook_digest, notes, recorded_by, started_at, finished_at)
  VALUES (p_drill_id, p_cluster_id, NULL, p_repository_id, 'latest', 'offline_runbook', p_outcome,
          p_runbook_digest, p_notes, p_recorded_by, p_started_at, p_finished_at);
END
$fn$;
REVOKE ALL ON FUNCTION backups.record_offline_drill(text, text, text, text, text, text, text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backups.record_offline_drill(text, text, text, text, text, text, text, timestamptz, timestamptz) TO exdb_serve;

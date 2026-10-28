#!/bin/sh
# D0 exploratory: mutation test of the three verify.sql files. Each mutation breaks one property the bundle's
# description promises, on a copy (template) of the fully migrated database; then the bundle's checks run
# (apply_bundles.py verify, which follows verify.ts). PASS (all checks green) on a broken bundle = a weak check.
cd "$(dirname "$0")"
NEW="01M61AGQKSBZ9VN71DHYFVCQHT 01M61C90YHV706H2B8EW39TBAF 01M61FKAJN5VP9H2E73K74NCZ2"
SRC=exponetdb_fresh
mut() {  # name, role, sql
  docker exec d0-pg psql -U postgres -q -c 'DROP DATABASE IF EXISTS exponetdb_mut WITH (FORCE)' >/dev/null
  docker exec d0-pg psql -U postgres -q -c "CREATE DATABASE exponetdb_mut TEMPLATE $SRC" >/dev/null
  printf '%s' "$3" | docker exec -i d0-pg psql -X -U "$2" -d exponetdb_mut -q -v ON_ERROR_STOP=1 >/dev/null 2>/tmp/mut.err || { echo "MUTATION '$1' could not be applied: $(head -c 200 /tmp/mut.err)"; return; }
  out=$(python3 apply_bundles.py exponetdb_mut verify $NEW 2>&1)
  fails=$(echo "$out" | grep -c 'CHECK FAIL')
  if [ "$fails" = "0" ]; then echo "MUTATION '$1': verify.sql still PASSES (weak check)"; else echo "MUTATION '$1': verify.sql FAILS ($fails check(s)) as it should"; fi
}
echo "== sanity: unmutated copy"; python3 apply_bundles.py $SRC verify $NEW | tail -1
# --- operation-supersession
mut "S1 recovery edge also allows needs_attention->verifying" exdb_migrate "CREATE OR REPLACE FUNCTION operations.recovery_transition_allowed(p_from text, p_to text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS \$f\$ SELECT (p_from, p_to) IN (('needs_attention','verification_failed'),('needs_attention','verifying')) \$f\$;"
mut "S2 recovery edge allows every pair" exdb_migrate "CREATE OR REPLACE FUNCTION operations.recovery_transition_allowed(p_from text, p_to text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS \$f\$ SELECT true \$f\$;"
mut "S3 guard is a no-op (any change allowed) but its text mentions recovery_transition_allowed in a comment" exdb_migrate "CREATE OR REPLACE FUNCTION operations.operation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS \$f\$ BEGIN /* operations.recovery_transition_allowed */ RETURN NEW; END \$f\$;"
mut "S4 guard calls the new function but ignores its result (OR true)" exdb_migrate "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('operations.operation_guard()'::regprocedure), 'OR operations.recovery_transition_allowed(OLD.state, NEW.state))', 'OR operations.recovery_transition_allowed(OLD.state, NEW.state) OR true)'); END \$d\$;"
mut "S5 guard replaced by the frozen original (CREATE OR REPLACE forgotten)" exdb_migrate "DO \$d\$ BEGIN EXECUTE replace(replace(pg_get_functiondef('operations.operation_guard()'::regprocedure), E'(operations.transition_allowed(OLD.state, NEW.state)\n                                     OR operations.recovery_transition_allowed(OLD.state, NEW.state))', 'operations.transition_allowed(OLD.state, NEW.state)'), 'x', 'x'); END \$d\$;"
mut "S6 guard loses the serve restriction (EXO02 block removed)" exdb_migrate "DO \$d\$ DECLARE d text := pg_get_functiondef('operations.operation_guard()'::regprocedure); BEGIN d := replace(d, 'IF current_user = ''exdb_serve''', 'IF false AND current_user = ''exdb_serve'''); EXECUTE d; END \$d\$;"
mut "S7 recovery_transition_allowed is owned by a superuser-like role (owner changed)" postgres "ALTER FUNCTION operations.recovery_transition_allowed(text,text) OWNER TO postgres;"
# --- ledger-reconcile
mut "L1 history trigger exists twice but fires on INSERT only (table no longer append-only)" exdb_migrate "DROP TRIGGER ledger_mirror_history_guard ON migrations.ledger_mirror_history; CREATE TRIGGER ledger_mirror_history_guard BEFORE INSERT ON migrations.ledger_mirror_history FOR EACH ROW EXECUTE FUNCTION control.reject_change();"
mut "L2 history guard trigger disabled" exdb_migrate "ALTER TABLE migrations.ledger_mirror_history DISABLE TRIGGER ledger_mirror_history_guard;"
mut "L3 archive_mirror_rows loses its pinned search_path" exdb_migrate "ALTER FUNCTION migrations.archive_mirror_rows(text,text,integer,text[],text) RESET search_path;"
mut "L4 archive_mirror_rows is a SECURITY INVOKER function" exdb_migrate "ALTER FUNCTION migrations.archive_mirror_rows(text,text,integer,text[],text) SECURITY INVOKER;"
mut "L5 archive_mirror_rows body drops the running-operation check (deletes any rows)" exdb_migrate "CREATE OR REPLACE FUNCTION migrations.archive_mirror_rows(p_operation text, p_target text, p_generation integer, p_ids text[], p_reason text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS \$f\$ DECLARE n integer; BEGIN DELETE FROM migrations.ledger_mirror WHERE target_id = p_target; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END \$f\$;"
mut "L6 archive_mirror_rows owned by a superuser" postgres "ALTER FUNCTION migrations.archive_mirror_rows(text,text,integer,text[],text) OWNER TO postgres;"
mut "L7 worker gains DELETE on the mirror" postgres "GRANT DELETE ON migrations.ledger_mirror TO exdb_worker;"
mut "L8 serve may execute archive_mirror_rows" exdb_migrate "GRANT EXECUTE ON FUNCTION migrations.archive_mirror_rows(text,text,integer,text[],text) TO exdb_serve;"
mut "L9 worker may INSERT into the history directly" exdb_migrate "GRANT INSERT ON migrations.ledger_mirror_history TO exdb_worker;"
# --- offline-drill-record
mut "D1 record_offline_drill search_path unpinned" exdb_migrate "ALTER FUNCTION backups.record_offline_drill(text,text,text,text,text,text,text,timestamptz,timestamptz) RESET search_path;"
mut "D2 record_offline_drill search_path is public first" exdb_migrate "ALTER FUNCTION backups.record_offline_drill(text,text,text,text,text,text,text,timestamptz,timestamptz) SET search_path = public, pg_catalog;"
mut "D3 record_offline_drill body inserts a control_plane 'passed' drill with an RTO (not an attestation)" exdb_migrate "CREATE OR REPLACE FUNCTION backups.record_offline_drill(p_drill_id text, p_cluster_id text, p_repository_id text, p_outcome text, p_runbook_digest text, p_notes text, p_recorded_by text, p_started_at timestamptz, p_finished_at timestamptz) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS \$f\$ BEGIN INSERT INTO backups.drills (drill_id, cluster_id, restore_id, repository_id, selection, mode, outcome, measured_rto_seconds, started_at, finished_at) VALUES (p_drill_id, p_cluster_id, NULL, p_repository_id, 'latest', 'control_plane', 'passed', 1, p_started_at, p_finished_at); END \$f\$;"
mut "D4 record_offline_drill owned by a superuser" postgres "ALTER FUNCTION backups.record_offline_drill(text,text,text,text,text,text,text,timestamptz,timestamptz) OWNER TO postgres;"
mut "D5 worker may execute record_offline_drill" exdb_migrate "GRANT EXECUTE ON FUNCTION backups.record_offline_drill(text,text,text,text,text,text,text,timestamptz,timestamptz) TO exdb_worker;"
mut "D6 serve gains INSERT on backups.drills" postgres "GRANT INSERT ON backups.drills TO exdb_serve;"
mut "D7 PUBLIC may execute record_offline_drill" exdb_migrate "GRANT EXECUTE ON FUNCTION backups.record_offline_drill(text,text,text,text,text,text,text,timestamptz,timestamptz) TO PUBLIC;"

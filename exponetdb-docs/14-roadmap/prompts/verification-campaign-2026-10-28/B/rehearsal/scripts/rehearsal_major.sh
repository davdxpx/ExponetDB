#!/usr/bin/env bash
# The import / baseline / plan / apply part of the rehearsal on another PostgreSQL major (schema only, no bulk data).
# usage: rehearsal_major.sh 16|18
source /srv/work/s5/rehearsal/rh-lib.sh
V="${1:?16|18}"; PORT=$((55400 + V)); T="rh$V"; S="rh${V}s"; cd "$PROJ"
export TAIL=6
tm "m$V-add-targets" bash -c "source /srv/work/s5/rehearsal/rh-lib.sh; add_target $T pg$V nonprod; add_target $S pg$V nonprod"
runuser -u postgres -- psql -X -q -p $PORT -d postgres -f "$RH/legacy/prereq_cluster.sql" >/dev/null 2>&1
for db in lab_$T lab_$S; do runuser -u postgres -- psql -X -q -p $PORT -d $db -f "$RH/legacy/prereq_db.sql" >/dev/null; done
runuser -u postgres -- psql -X -q -p $PORT -d lab_$S -c 'create extension if not exists "uuid-ossp" schema extensions; create extension if not exists pgcrypto schema extensions; create extension if not exists pg_trgm schema extensions; grant usage on schema extensions to anon, authenticated, service_role;'
tm "m$V-legacy-apply" "$RH/apply_legacy.sh" "lab_$T" $PORT
for db in lab_$T lab_$S; do runuser -u postgres -- psql -X -q -p $PORT -d $db -c "grant usage on schema auth, storage, app_private to exponetdb_observer" 2>/dev/null; done
runuser -u postgres -- psql -X -q -p $PORT -d lab_$T -c "grant usage on schema supabase_migrations to exponetdb_observer; grant select on supabase_migrations.schema_migrations to exponetdb_observer;"
# observer may not exist before the first bootstrap grants; the script above ran after add_target, so it does
tm "m$V-scratch-check" exdb migration import scratch-check --target "lab/platform/$T" --scratch "lab/platform/$S"
"$RH/run_analysis.sh" "$T" "$S" "m$V" 2>&1 | tail -4
R=$(ctl_sql "select report_id from migrations.import_reports where target_id='$(target_id lab/platform/$T)' order by created_at desc limit 1")
echo "report $R"
tm "m$V-resolve" "$RH/resolve_all.sh" "$R" "$T"
tm "m$V-baseline" exdb migration import baseline "$R" --target "lab/platform/$T" --apply
tm "m$V-plan-all" exdb migration plan --target "lab/platform/$T"
PL=$(grep -o "pln_[A-Z0-9]*" "$L/m$V-plan-all.log" | head -1)
tm "m$V-apply-all" exdb plan apply "$PL" --wait
echo "=== ledger head and drift on PG$V"
psql_target pg$V -d lab_$T -Atc "select count(*) from exponetdb.schema_migrations"
TAIL=5 tm "m$V-drift" exdb drift check "lab/platform/$T"

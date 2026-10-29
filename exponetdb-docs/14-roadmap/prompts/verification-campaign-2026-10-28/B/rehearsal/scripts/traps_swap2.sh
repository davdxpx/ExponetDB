#!/usr/bin/env bash
# Task B (i), the decisive half: after the clone took the registered name, a NEW plan is made and applied against the clone.
source /srv/work/s5/rehearsal/rh-lib.sh
cd "$PROJ"; P=55418
SU() { runuser -u postgres -- psql -X -q -p $P -d postgres -v ON_ERROR_STOP=1 "$@"; }
kick() { SU -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$1' and pid<>pg_backend_pid()" >/dev/null; }
flag() { runuser -u postgres -- psql -X -Atq -p $P -d "$1" -c "select 'in '||current_database()||' (oid '||(select oid from pg_database where datname=current_database())||'): hr_accounts.flag '||case when exists (select 1 from information_schema.columns where table_name='hr_accounts' and column_name='flag') then 'EXISTS' else 'absent' end||', ledger rows '||(select count(*) from exponetdb.schema_migrations)" 2>&1 | head -1; }
E1=$(cat "$L/e1.id")
kick lab_rh18; sleep 1
SU -c "drop database if exists lab_rh18c"; SU -c "create database lab_rh18c TEMPLATE lab_rh18 OWNER lab_owner"
kick lab_rh18; kick lab_rh18c
SU -c "alter database lab_rh18 rename to lab_rh18_orig" && SU -c "alter database lab_rh18c rename to lab_rh18"
sleep 3
echo "oids now:"; flag lab_rh18; flag lab_rh18_orig
echo "registry's recorded database oid:"; ctl_sql "select * from registry.databases where name='lab_rh18'" 2>&1 | head -3 | cut -c1-300
TAIL=10 tm swap2-plan exdb migration plan "$E1" --target lab/platform/rh18
P2=$(grep -o "pln_[A-Z0-9]*" "$L/swap2-plan.log" | head -1); echo "plan made against the clone: $P2"
TAIL=18 tm swap2-apply exdb plan apply "$P2" --wait
echo "=== after the apply attempt"; flag lab_rh18; flag lab_rh18_orig
ctl_sql "select operation_id, state, apply_outcome, error_code from operations.operations order by created_at desc limit 2"

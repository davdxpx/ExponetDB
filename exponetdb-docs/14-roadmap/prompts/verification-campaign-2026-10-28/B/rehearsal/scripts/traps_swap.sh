#!/usr/bin/env bash
# Task B (i) "point the first target's connection at the clone" and (ii) rename, on lab/platform/rh18 (PG18, nonprod, baselined, all bundles applied).
source /srv/work/s5/rehearsal/rh-lib.sh
cd "$PROJ"
P=55418
SU() { runuser -u postgres -- psql -X -q -p $P -d postgres -v ON_ERROR_STOP=1 "$@"; }
kick() { SU -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$1' and pid<>pg_backend_pid()" >/dev/null; }
flag() { runuser -u postgres -- psql -X -Atq -p $P -d "$1" -c "select 'in '||current_database()||': hr_accounts.flag column '||case when exists (select 1 from information_schema.columns where table_name='hr_accounts' and column_name='flag') then 'EXISTS' else 'absent' end||', ledger rows '||(select count(*) from exponetdb.schema_migrations)" 2>&1 | head -1; }
D1=$(cat $L/d1.id)
VERIFY_SQL="SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='hr_accounts' AND column_name='flag') AS ok;" mkb "$PROJ" add-hr-accounts-flag --depends-on "$D1" > "$L/e1.id" <<'SQL'
ALTER TABLE public.hr_accounts ADD COLUMN IF NOT EXISTS flag boolean;
SQL
E1=$(cat "$L/e1.id"); echo "bundle E1=$E1"
TAIL=3 tm swap-plan-before exdb migration plan "$E1" --target lab/platform/rh18
P1=$(grep -o "pln_[A-Z0-9]*" "$L/swap-plan-before.log" | head -1); echo "plan made BEFORE the swap: $P1"
echo "=== make a clone (TEMPLATE) and swap names so that the registered name now leads to the clone"
kick lab_rh18; sleep 1
SU -c "create database lab_rh18c TEMPLATE lab_rh18 OWNER lab_owner"
kick lab_rh18; kick lab_rh18c
SU -c "alter database lab_rh18 rename to lab_rh18_orig" && SU -c "alter database lab_rh18c rename to lab_rh18"
flag lab_rh18; flag lab_rh18_orig
echo "=== the product, 5 s later"; sleep 5
TAIL=14 tm swap-target-show exdb target show lab/platform/rh18
TAIL=10 tm swap-drift exdb drift check lab/platform/rh18
TAIL=10 tm swap-status exdb migration status --target lab/platform/rh18
TAIL=8 tm swap-plan-after exdb migration plan "$E1" --target lab/platform/rh18
echo "=== apply of the plan made before the swap"
TAIL=10 tm swap-apply-old-plan exdb plan apply "$P1" --wait
echo "=== did anything run on the clone?"; flag lab_rh18; flag lab_rh18_orig
echo "=== swap back"
kick lab_rh18; kick lab_rh18_orig
SU -c "alter database lab_rh18 rename to lab_rh18c" && SU -c "alter database lab_rh18_orig rename to lab_rh18"
sleep 5; TAIL=6 tm swap-back-status exdb migration status --target lab/platform/rh18
echo "=== (ii) rename of the registered database without any clone"
kick lab_rh18
SU -c "alter database lab_rh18 rename to lab_rh18_renamed"
sleep 5
TAIL=10 tm rename-target-show exdb target show lab/platform/rh18
TAIL=8 tm rename-plan exdb migration plan "$E1" --target lab/platform/rh18
kick lab_rh18_renamed; SU -c "alter database lab_rh18_renamed rename to lab_rh18"; sleep 4
TAIL=6 tm rename-back-status exdb migration status --target lab/platform/rh18

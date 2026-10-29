#!/usr/bin/env bash
# observability step 11: a ledger row nobody planned on lab/platform/staging (copy of the newest row, other id and name), then what
# the product says: migration status, target show, a forced drift check, the findings, and a plan (LEDGER_DIVERGENCE?).
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/obs-seed2.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
bearer
q() { PGDATABASE=lab_staging psql_target pg17 "$@"; }
COLS=$(q -Atc "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='exponetdb' and table_name='schema_migrations' and column_name <> 'applied_seq'")
echo "ledger rows before: $(q -Atc 'select count(*) from exponetdb.schema_migrations')"
q -v ON_ERROR_STOP=1 -c "INSERT INTO exponetdb.schema_migrations ($COLS) SELECT $(echo "$COLS" | sed "s/^migration_id/'01ZZZZZZZZZZZZZZZZZZZZZZZ0'/; s/,name,/,'s6-hand-made',/") FROM exponetdb.schema_migrations ORDER BY applied_seq DESC LIMIT 1" 2>&1 | head -3
q -Atc "select migration_id||' '||name||' op='||operation_id from exponetdb.schema_migrations order by applied_seq" | tail -3
echo "== $(now) what the product says about it (no plan, no human action in between)"
echo "migration status: $(exdb migration status --target lab/platform/staging 2>&1 | tr '\n' ' ' | cut -c1-600)"
echo "target show: $(exdb target show lab/platform/staging 2>&1 | grep -iE 'ledger|diverg|finding|applied' | head -6 | tr '\n' '|' | cut -c1-500)"
echo "-- forced drift check:"; exdb drift check lab/platform/staging --yes 2>&1 | tr '\n' ' ' | cut -c1-300; echo
sleep 20
echo "findings: $(exdb_json finding list | jq -c '[.data.items[]?|{k:(.kind // .code),t:(.subject // .targetId)}] | map(.k) | group_by(.) | map({k:.[0],n:length})' | head -c 500)"
echo "ledger_state in the store: $(ctl_sql "select * from migrations.ledger_state" 2>&1 | head -4 | cut -c1-300)"
d=$(new_project s6div2); echo "SELECT 1;" | mkb "$d" div2 >/dev/null
echo "migration plan on staging: $(cd $d; exdb migration plan --target lab/platform/staging 2>&1 | tr '\n' ' ' | cut -c1-700)"
echo "logs: $(logs_since worker "-3 min" | jq -rc 'select(.level=="warn" or .level=="error")|[.msg,.targetId]|@tsv' | sort | uniq -c | head -3 | tr '\n' '|')"
# clean up the hand-made row so later tests are not confused
q -qAt -c "DELETE FROM exponetdb.schema_migrations WHERE migration_id='01ZZZZZZZZZZZZZZZZZZZZZZZ0'" 2>&1 | head -2

#!/usr/bin/env bash
# observability steps 11 and 14 (seed part): a hand-made ledger row on the production target (divergence nobody planned),
# and an operation parked in awaiting_approval. Read back later with obs-read.sh.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/obs-seed.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
N=$(jq -r .node ${EXSTACK_STATE}/ids.json); C=$(jq -r .cluster_pg17 ${EXSTACK_STATE}/ids.json)
echo "== ledger divergence on lab/platform/production (pg17, lab_production) $(now)"
PGDATABASE=lab_production psql_target pg17 -c '\d exponetdb.schema_migrations' | head -30
PGDATABASE=lab_production psql_target pg17 -Atc "select count(*) from exponetdb.schema_migrations"
echo "-- hand-made ledger row (copy of the last row, other id and name), as the database superuser:"
PGDATABASE=lab_production psql_target pg17 -v ON_ERROR_STOP=1 -c "CREATE TEMP TABLE t AS SELECT * FROM exponetdb.schema_migrations ORDER BY applied_seq DESC LIMIT 1; UPDATE t SET migration_id='01ZZZZZZZZZZZZZZZZZZZZZZZ0', name='s6-hand-made', applied_seq=applied_seq+1; INSERT INTO exponetdb.schema_migrations SELECT * FROM t" 2>&1 | head -4
PGDATABASE=lab_production psql_target pg17 -Atc "select migration_id||' '||name from exponetdb.schema_migrations order by applied_seq"
echo "== awaiting_approval operation $(now)"
bearer
exdb_json node postgres reload $N --cluster $C --no-wait > $L6/obs-plan.json; PLAN=$(jq -r '.data.id // empty' $L6/obs-plan.json); echo "plan=$PLAN"
exdb plan apply $PLAN --yes --no-wait 2>&1 | sed 's/Code: .*/Code: <x>/' | head -6
echo "op: $(ctl_sql "select operation_id||' '||state||' created '||created_at from operations.operations where kind='postgres.reload' order by created_at desc limit 1")"

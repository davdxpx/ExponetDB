#!/bin/sh
# D0 exploratory exercise E: TOCTOU between the "running ledger.reconcile" check and the DELETE inside
# migrations.archive_mirror_rows, with and without the FOR SHARE fence the engine takes (leaseHeld).
# Needs reset_and_load.sh first. Three concurrent sessions of the worker role.
cd "$(dirname "$0")"
P="docker exec -i d0-pg psql -X -U exdb_worker -d exponetdb_control -v VERBOSITY=terse"
if [ "$1" != "e2" ]; then
echo "--- E1: no fence (a raw call of the function) while the operation leaves 'running' during the DELETE's lock wait"
( echo "BEGIN; SELECT 'holder locks M1 at ' || clock_timestamp()::time FROM migrations.ledger_mirror WHERE target_id='tgt_01M61C90YHV706H2B8EW39TBA1' AND generation=2 AND migration_id='M1' FOR UPDATE; SELECT pg_sleep(6); COMMIT; SELECT 'holder committed at ' || clock_timestamp()::time;" | $P -tA ) &
sleep 1
( echo "BEGIN; SELECT 'caller starts at ' || clock_timestamp()::time; SELECT 'caller moved ' || migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1','M2'],'missing') || ' rows at ' || clock_timestamp()::time; COMMIT;" | $P -tA ) &
sleep 1
( echo "SELECT 'flip: R1 running -> verifying' ; UPDATE operations.operations SET state='verifying', apply_outcome='applied', verification_outcome='pending' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ1'; SELECT 'flip committed at ' || clock_timestamp()::time;" | $P -tA ) &
wait
$P -tA -c "SELECT 'R1 state now: ' || state FROM operations.operations WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ1'" -c "SELECT 'history rows written for R1: ' || count(*) FROM migrations.ledger_mirror_history WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ1'"
fi
if [ "$1" != "e1" ]; then
echo "--- E2: with the engine's fence (SELECT ... FOR SHARE on the operation row, records.ts/leases.ts leaseHeld)"
( echo "BEGIN; SELECT 'holder locks X1 at ' || clock_timestamp()::time FROM migrations.ledger_mirror WHERE target_id='tgt_01M61C90YHV706H2B8EW39TBA2' AND generation=1 AND migration_id='X1' FOR UPDATE; SELECT pg_sleep(6); COMMIT; SELECT 'holder committed at ' || clock_timestamp()::time;" | $P -tA ) &
sleep 1
( echo "BEGIN; SELECT 'fenced caller starts at ' || clock_timestamp()::time; SELECT 'fence held (leaseHeld: ... FOR SHARE) for ' || operation_id FROM operations.operations WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ2' AND lease_owner='prc_01M61C90YHV706H2B8EW39TBW1' AND lease_expires_at > clock_timestamp() FOR SHARE; SELECT 'fenced caller moved ' || migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ2','tgt_01M61C90YHV706H2B8EW39TBA2',1,ARRAY['X1','X2'],'missing') || ' rows at ' || clock_timestamp()::time; COMMIT; SELECT 'fenced caller committed at ' || clock_timestamp()::time;" | $P -tA ) &
sleep 1
( echo "SELECT 'flip: R2 running -> verifying (waits for the fence)'; UPDATE operations.operations SET state='verifying', apply_outcome='applied', verification_outcome='pending' WHERE operation_id='op_01M61C90YHV706H2B8EW39TBQ2'; SELECT 'flip committed at ' || clock_timestamp()::time;" | $P -tA ) &
wait
fi

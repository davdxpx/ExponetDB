#!/bin/sh
# D0 exploratory exercise F: two concurrent calls of archive_mirror_rows for the same rows (needs reset_and_load.sh).
cd "$(dirname "$0")"
P="docker exec -i d0-pg psql -X -U exdb_worker -d exponetdb_control -tA"
( echo "BEGIN; SELECT 'first moved ' || migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1','M2'],'missing'); SELECT pg_sleep(4); COMMIT;" | $P ) &
sleep 1
( echo "SELECT 'second moved ' || migrations.archive_mirror_rows('op_01M61C90YHV706H2B8EW39TBQ1','tgt_01M61C90YHV706H2B8EW39TBA1',2,ARRAY['M1','M2'],'missing');" | $P ) &
wait
$P -c "SELECT 'history rows for M1,M2: ' || count(*) || ' (distinct ' || count(DISTINCT migration_id) || ')' FROM migrations.ledger_mirror_history"

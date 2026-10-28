#!/usr/bin/env bash
# Checks that need more than one session or run outside a transaction.
# Run after 00-setup.sh. Libpq variables select the server; PGDATABASE defaults to b3_ddl.
set -uo pipefail
export PGDATABASE="${PGDATABASE:-b3_ddl}"
q() { psql -X -q -At -v ON_ERROR_STOP=0 "$@" 2>&1 | grep -v '^$'; }
now() { date +%s.%N; }

echo "### h31 ALTER EXTENSION ... UPDATE inside a transaction (pg_trgm 1.5 -> newest)"
q <<'SQL'
BEGIN;
CREATE EXTENSION pg_trgm VERSION '1.5';
SELECT 'before: ' || extversion FROM pg_extension WHERE extname = 'pg_trgm';
ALTER EXTENSION pg_trgm UPDATE;
SELECT 'after:  ' || extversion FROM pg_extension WHERE extname = 'pg_trgm';
SELECT 'relation locks: ' || chk.locks();
ROLLBACK;
SQL

echo "### h35 VACUUM FULL: rewrite and lock conflict with a plain reader (lock_timeout 500ms)"
fn0=$(q -c "SELECT pg_relation_filenode('public.orders')")
( q -c "BEGIN; SELECT count(*) FROM public.orders; SELECT pg_sleep(3); COMMIT;" >/dev/null ) &
sleep 0.7
q -c "SET lock_timeout='500ms'" -c "VACUUM FULL public.orders"
wait
q -c "VACUUM FULL public.orders;"
fn1=$(q -c "SELECT pg_relation_filenode('public.orders')")
echo "relfilenode changed by VACUUM FULL: $([ "$fn0" != "$fn1" ] && echo true || echo false)"

echo "### h41 CREATE INDEX CONCURRENTLY failure leaves an INVALID index; the same statement with IF NOT EXISTS skips it"
q <<'SQL'
CREATE TABLE public.dup_probe AS SELECT 1 AS v FROM generate_series(1, 3);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS dup_probe_v ON public.dup_probe (v);
SELECT 'after failure: ' || indexrelid::regclass || ' indisvalid=' || indisvalid || ' indisready=' || indisready FROM pg_index WHERE indrelid = 'public.dup_probe'::regclass;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS dup_probe_v ON public.dup_probe (v);
SELECT 'after the retry: ' || indexrelid::regclass || ' indisvalid=' || indisvalid FROM pg_index WHERE indrelid = 'public.dup_probe'::regclass;
DROP INDEX CONCURRENTLY dup_probe_v;
DROP TABLE public.dup_probe;
SQL

echo "### locks of concurrent builds, sampled from a second session while a slow index expression keeps them open"
q -c "DROP TABLE IF EXISTS public.slow_probe; CREATE TABLE public.slow_probe AS SELECT g::bigint AS id FROM generate_series(1, 150) g;" >/dev/null
sample() { # application_name
  q -c "SELECT string_agg(c.relname || ':' || l.mode, ', ' ORDER BY c.relname, l.mode)
          FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid JOIN pg_class c ON c.oid = l.relation
         WHERE a.application_name = '$1' AND l.locktype = 'relation' AND c.relname = 'slow_probe'"
}
for stmt in \
  "CREATE INDEX slow_plain ON public.slow_probe ((chk.slow(id)))" \
  "CREATE INDEX CONCURRENTLY slow_conc ON public.slow_probe ((chk.slow(id)))"; do
  ( PGAPPNAME=probe q -c "$stmt" >/dev/null ) &
  sleep 1.2
  echo "$stmt  ->  $(sample probe)"
  wait
done
q -c "CREATE INDEX slow_base ON public.slow_probe ((chk.slow(id)))" >/dev/null
( PGAPPNAME=probe q -c "REINDEX TABLE CONCURRENTLY public.slow_probe" >/dev/null ) &
sleep 1.2
echo "REINDEX TABLE CONCURRENTLY  ->  $(sample probe)"
wait
q -c "DROP TABLE public.slow_probe" >/dev/null

echo "### lock queue: DDL waits behind a reader, a later plain SELECT queues behind the DDL (lock_timeout = engine default 5s)"
base=$(now); q -c "SELECT count(*) FROM public.orders WHERE id = 1" >/dev/null; t=$(now)
printf 'baseline SELECT: %.3f s\n' "$(echo "$t - $base" | bc -l)"
( q -c "BEGIN; SELECT count(*) FROM public.orders; SELECT pg_sleep(9); COMMIT;" >/dev/null ) &
sleep 1
( q -c "SET lock_timeout='5s'; ALTER TABLE public.orders ADD COLUMN q1 int;" | sed 's/^/DDL session: /' ) &
sleep 1
s=$(now); q -c "SELECT count(*) FROM public.orders WHERE id = 1" >/dev/null; e=$(now)
printf 'SELECT issued 1 s after the DDL started waiting: %.3f s (the reader holds the table for 9 s, the DDL gives up after 5 s)\n' "$(echo "$e - $s" | bc -l)"
wait
q -c "SELECT 'column q1 exists after the timeout: ' || exists(SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='q1')"

echo "### h45 DETACH PARTITION CONCURRENTLY only works in autocommit (then re-attach to restore)"
psql -X -q -c "ALTER TABLE public.events DETACH PARTITION public.events_2026_10 CONCURRENTLY" && echo "autocommit detach: ok"
psql -X -q -c "ALTER TABLE public.events ATTACH PARTITION public.events_2026_10 FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')" && echo "re-attached"

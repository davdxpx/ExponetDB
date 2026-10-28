#!/usr/bin/env bash
# Builds the benchmark database: the fixture base schema (orders, order_items,
# events, views, matview, ...) with ROWS orders (default 10,000,000), 2*ROWS
# order_items, two extra indexes on orders and the bench sequence.
# Libpq variables select the server (PGHOST PGPORT PGUSER PGPASSWORD); the
# database is PGDATABASE (default ddl_bench) and is dropped and recreated.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export PGDATABASE="${PGDATABASE:-ddl_bench}" ROWS="${ROWS:-10000000}"
"$here/../pgcheck/00-setup.sh"
psql -X -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE SEQUENCE public.bench_seq;
CREATE INDEX orders_customer_created_idx ON public.orders (customer_id, created_at);
CREATE INDEX orders_status_idx ON public.orders (status);
ANALYZE public.orders;
SQL
psql -X -At -c "SELECT 'orders=' || (SELECT reltuples::bigint FROM pg_class WHERE oid='public.orders'::regclass) || ' size=' || pg_size_pretty(pg_total_relation_size('public.orders')) || ' indexes=' || (SELECT count(*) FROM pg_index WHERE indrelid='public.orders'::regclass)"

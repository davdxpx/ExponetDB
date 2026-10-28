#!/usr/bin/env bash
# Creates the database $PGDATABASE (default b3_ddl) on the server named by the
# standard libpq variables (PGHOST PGPORT PGUSER PGPASSWORD), loads the fixture
# base schema from fixtures/hazard (the same up.sql the lint analyses), the
# roles it grants to, ROWS rows of data (default 100000), and the helper
# schema chk used by the checks. Idempotent: drops and recreates the database.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export PGDATABASE_ADMIN="${PGDATABASE_ADMIN:-postgres}"
DB="${PGDATABASE:-b3_ddl}"
ROWS="${ROWS:-100000}"
psql_admin() { PGDATABASE="$PGDATABASE_ADMIN" psql -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_db() { PGDATABASE="$DB" psql -X -q -v ON_ERROR_STOP=1 "$@"; }

psql_admin -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
psql_db -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shop_owner') THEN CREATE ROLE shop_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shop_app') THEN CREATE ROLE shop_app NOLOGIN; END IF;
END \$\$"
base="$(ls -d "$here"/../fixtures/hazard/*_h00-base-shop-schema)/up.sql"
psql_db -f "$base"
psql_db -c "CREATE UNIQUE INDEX order_totals_pk ON public.order_totals (customer_id)"

psql_db -v rows="$ROWS" <<'SQL'
INSERT INTO public.customers SELECT g, 'c' || g || '@example.test' FROM generate_series(1, 1000) g;
INSERT INTO public.orders (customer_id, ref, amount, note, legacy_ref, created_at, payload)
  SELECT 1 + (g % 1000), 'R-' || g, 100 + (g % 900), 'note ' || g, 'L' || g,
         timestamp '2026-01-01' + (g || ' seconds')::interval, jsonb_build_object('n', g)
    FROM generate_series(1, :rows) g;
INSERT INTO public.order_items SELECT g, 1 + (g % :rows), 'sku-' || (g % 50), 1 + (g % 5)
    FROM generate_series(1, :rows * 2) g;
INSERT INTO public.audit_log SELECT g, now(), 'm' || g FROM generate_series(1, :rows / 10) g;
INSERT INTO public.events SELECT g, timestamptz '2026-10-01' + (g % 2000000 || ' seconds')::interval, 'k' FROM generate_series(1, :rows / 2) g;
INSERT INTO public.events_2026_11 SELECT g, timestamptz '2026-11-01' + (g % 2000000 || ' seconds')::interval, 'k' FROM generate_series(1, :rows / 10) g;
REFRESH MATERIALIZED VIEW public.order_totals;
ANALYZE;

-- Helpers: what the current backend holds, and scan counters of this transaction.
CREATE SCHEMA chk;
CREATE FUNCTION chk.locks() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(c.relname || ':' || l.mode || CASE WHEN l.granted THEN '' ELSE '(waiting)' END, ', ' ORDER BY c.relname, l.mode), '-')
    FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
   WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation'
     AND c.relkind IN ('r','p','v','m','S') AND c.relnamespace = 'public'::regnamespace
     AND l.mode <> 'AccessShareLock'
$$;
CREATE FUNCTION chk.scans(r regclass) RETURNS bigint LANGUAGE sql AS $$ SELECT pg_stat_get_xact_numscans(r) $$;
CREATE FUNCTION chk.fn(r regclass) RETURNS oid LANGUAGE sql AS $$ SELECT pg_relation_filenode(r) $$;
-- An index expression that sleeps, to hold a concurrent build open long enough to sample pg_locks.
CREATE FUNCTION chk.slow(x bigint) RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN PERFORM pg_sleep(0.02); RETURN x; END $$;
SQL
echo "setup done: $DB with $ROWS orders"

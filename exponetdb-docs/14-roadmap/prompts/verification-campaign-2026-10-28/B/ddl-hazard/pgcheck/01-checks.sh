#!/usr/bin/env bash
# Checks the lint/plan classification of each DDL pattern against PostgreSQL
# itself. Every check runs in its own transaction that is rolled back, and
# reports for the watched relation:
#   rewritten  = the relfilenode changed (a table rewrite)
#   seq_scans  = sequential scans of the relation inside the transaction
#   locks      = relation locks held at that point (AccessShareLock omitted)
# Run after 00-setup.sh. Libpq variables select the server; PGDATABASE defaults to b3_ddl.
set -uo pipefail
export PGDATABASE="${PGDATABASE:-b3_ddl}"
run() { psql -X -q -v ON_ERROR_STOP=0 "$@" 2>&1 | grep -v '^$'; }

# chk <id> <watched relation> <sql...>
chk() {
  local id="$1" rel="$2" stmt="$3"
  echo "### $id"
  run -v rel="$rel" <<SQL
\\t on
\\pset fieldsep ' | '
BEGIN;
SELECT :'rel'::regclass::oid AS oid0, coalesce(chk.fn(:'rel'::regclass), 0) AS fn0, chk.scans(:'rel'::regclass) AS sc0,
       greatest(pg_relation_size(:'rel'::regclass), 1) AS sz0 \\gset
$stmt
SELECT 'rewritten=' || (coalesce(chk.fn(:oid0::oid::regclass), 0) <> :fn0) || ' seq_scans=' || (chk.scans(:oid0::oid::regclass) - :sc0)
       || ' size_x=' || round(pg_relation_size(:oid0::oid::regclass)::numeric / :sz0, 2) || ' locks=' || chk.locks();
ROLLBACK;
SQL
}

echo "server: $(psql -X -At -c 'select version()' | cut -c1-40)  TimeZone=$(psql -X -At -c 'show timezone')"

chk h01-create-index-plain public.orders "CREATE INDEX idx_orders_customer ON public.orders (customer_id);"
chk h04-add-column-volatile-uuid public.orders "ALTER TABLE public.orders ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid();"
chk h05-add-column-const-default public.orders "ALTER TABLE public.orders ADD COLUMN archived boolean NOT NULL DEFAULT false;"
chk h06-add-column-now-default public.orders "ALTER TABLE public.orders ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();"
chk h06b-add-column-clock-timestamp public.orders "ALTER TABLE public.orders ADD COLUMN touched timestamptz NOT NULL DEFAULT clock_timestamp();"
chk h07-add-column-immutable-fn public.orders "ALTER TABLE public.orders ADD COLUMN slug text NOT NULL DEFAULT lower('NEW');"
chk h08-add-column-bigserial public.orders "ALTER TABLE public.orders ADD COLUMN seq bigserial;"
chk h09-add-column-identity public.orders "ALTER TABLE public.orders ADD COLUMN line_no bigint GENERATED ALWAYS AS IDENTITY;"
chk h10-add-column-generated-stored public.orders "ALTER TABLE public.orders ADD COLUMN amount_cents bigint GENERATED ALWAYS AS (amount::bigint * 100) STORED;"
chk h10b-add-column-nullable-no-default public.orders "ALTER TABLE public.orders ADD COLUMN public_id uuid;"
chk h11-alter-type-int-to-numeric public.orders "ALTER TABLE public.orders ALTER COLUMN amount TYPE numeric(12,2);"
chk h11b-alter-type-int-to-bigint public.order_items "ALTER TABLE public.order_items ALTER COLUMN qty TYPE bigint;"
chk h12-alter-type-varchar-widen public.orders "ALTER TABLE public.orders ALTER COLUMN note TYPE varchar(500);"
chk h12b-alter-type-varchar-to-text public.orders "ALTER TABLE public.orders ALTER COLUMN note TYPE text;"
chk h12c-alter-type-varchar-narrow public.orders "ALTER TABLE public.orders ALTER COLUMN note TYPE varchar(100);"
chk h13-alter-type-timestamp-tz-utc public.orders "SET LOCAL TimeZone = 'UTC';
ALTER TABLE public.orders ALTER COLUMN created_at TYPE timestamptz;"
chk h13b-alter-type-timestamp-tz-berlin public.orders "SET LOCAL TimeZone = 'Europe/Berlin';
ALTER TABLE public.orders ALTER COLUMN created_at TYPE timestamptz;"
chk h14-set-not-null public.orders "ALTER TABLE public.orders ALTER COLUMN customer_id SET NOT NULL;"
chk h14b-not-null-with-valid-check public.orders "ALTER TABLE public.orders ADD CONSTRAINT nn CHECK (customer_id IS NOT NULL) NOT VALID;
ALTER TABLE public.orders VALIDATE CONSTRAINT nn;
SELECT 'after VALIDATE: scans=' || (chk.scans('public.orders') - :sc0) || ' locks=' || chk.locks();
SELECT chk.scans('public.orders') AS sc1 \\gset
ALTER TABLE public.orders ALTER COLUMN customer_id SET NOT NULL;
SELECT 'SET NOT NULL itself: scans=' || (chk.scans('public.orders') - :sc1);"
chk h15-add-check-validated public.orders "ALTER TABLE public.orders ADD CONSTRAINT orders_amount_pos CHECK (amount >= 0);"
chk h15b-add-check-not-valid public.orders "ALTER TABLE public.orders ADD CONSTRAINT orders_amount_pos CHECK (amount >= 0) NOT VALID;"
chk h15c-validate-constraint public.orders "ALTER TABLE public.orders ADD CONSTRAINT orders_amount_pos CHECK (amount >= 0) NOT VALID;
COMMIT; BEGIN;
SELECT chk.scans('public.orders') AS sc1 \\gset
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_amount_pos;
SELECT 'VALIDATE alone: scans=' || (chk.scans('public.orders') - :sc1) || ' locks=' || chk.locks();
ALTER TABLE public.orders DROP CONSTRAINT orders_amount_pos; COMMIT; BEGIN;"
chk h16-add-fk-validated public.order_items "ALTER TABLE public.order_items ADD CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES public.orders (id);"
chk h16b-add-fk-not-valid public.order_items "ALTER TABLE public.order_items ADD CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES public.orders (id) NOT VALID;"
chk h16c-validate-fk public.order_items "ALTER TABLE public.order_items ADD CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES public.orders (id) NOT VALID;
COMMIT; BEGIN;
SELECT chk.scans('public.order_items') AS sc1 \\gset
ALTER TABLE public.order_items VALIDATE CONSTRAINT order_items_order_fk;
SELECT 'VALIDATE alone: scans=' || (chk.scans('public.order_items') - :sc1) || ' locks=' || chk.locks();
ALTER TABLE public.order_items DROP CONSTRAINT order_items_order_fk; COMMIT; BEGIN;"
chk h17-add-unique-constraint public.orders "ALTER TABLE public.orders ADD CONSTRAINT orders_ref_key UNIQUE (ref);"
chk h17b-unique-using-index public.orders "CREATE UNIQUE INDEX orders_ref_uidx ON public.orders (ref);
SELECT chk.scans('public.orders') AS sc1 \\gset
ALTER TABLE public.orders ADD CONSTRAINT orders_ref_key UNIQUE USING INDEX orders_ref_uidx;
SELECT 'USING INDEX step itself: scans=' || (chk.scans('public.orders') - :sc1);"
chk h18-enum-add-value-and-use public.orders "ALTER TYPE public.order_status ADD VALUE 'refunded';
UPDATE public.orders SET status = 'refunded' WHERE ref = 'R-0';"
chk h19-enum-add-value-alone public.orders "ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'cancelled';"
chk h21-drop-column public.orders "ALTER TABLE public.orders DROP COLUMN legacy_ref;"
chk h22-rename-column public.orders "ALTER TABLE public.orders RENAME COLUMN note TO memo;"
chk h23-rename-table public.order_items "ALTER TABLE public.order_items RENAME TO order_lines;"
chk h24-lock-held-across-backfill public.orders "ALTER TABLE public.orders ADD COLUMN region text;
UPDATE public.orders SET region = 'eu' WHERE created_at >= '2000-01-01';
SELECT 'after the UPDATE, still held: ' || chk.locks();"
chk h25-update-no-where public.orders "UPDATE public.orders SET note = lower(note);"
chk h27-truncate public.audit_log "TRUNCATE public.audit_log;"
chk h28-create-trigger public.orders "CREATE TRIGGER orders_audit AFTER INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.audit_row();"
chk h29-create-policy public.orders "CREATE POLICY orders_app_select ON public.orders FOR SELECT TO shop_app USING (customer_id IS NOT NULL);"
chk h30-enable-rls public.orders "ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;"
chk h32-attach-partition public.events_2026_11 "ALTER TABLE public.events ATTACH PARTITION public.events_2026_11 FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');"
chk h32b-attach-with-valid-check public.events_2026_11 "ALTER TABLE public.events_2026_11 ADD CONSTRAINT b CHECK (happened_at >= '2026-11-01' AND happened_at < '2026-12-01') NOT VALID;
ALTER TABLE public.events_2026_11 VALIDATE CONSTRAINT b;
SELECT chk.scans('public.events_2026_11') AS sc1 \\gset
ALTER TABLE public.events ATTACH PARTITION public.events_2026_11 FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
SELECT 'ATTACH itself: scans=' || (chk.scans('public.events_2026_11') - :sc1);"
chk h33-drop-index-plain public.orders "DROP INDEX public.idx_orders_old;"
chk h34-reindex-table public.orders "REINDEX TABLE public.orders;"
chk h36-cluster public.orders "CLUSTER public.orders USING orders_pkey;"
chk h37-set-unlogged public.audit_log "ALTER TABLE public.audit_log SET UNLOGGED;"
chk h38-alter-sequence-restart public.orders_id_seq "ALTER SEQUENCE public.orders_id_seq RESTART WITH 1;"
chk h39-replace-view public.open_orders "CREATE OR REPLACE VIEW public.open_orders AS SELECT id, customer_id, status, ref FROM public.orders WHERE status <> 'shipped';"
chk h40-refresh-matview public.order_totals "REFRESH MATERIALIZED VIEW public.order_totals;"
chk h40b-refresh-matview-concurrently-in-tx public.order_totals "REFRESH MATERIALIZED VIEW CONCURRENTLY public.order_totals;"
chk h41-cic-in-transaction public.orders "CREATE INDEX CONCURRENTLY idx_orders_status ON public.orders (status);"
chk h45-detach-concurrently-in-tx public.events_2026_10 "ALTER TABLE public.events DETACH PARTITION public.events_2026_10 CONCURRENTLY;"

/**
 * Fixture specs for the DDL hazard matrix (B3). One bundle per pattern.
 * `hazard` bundles are the dangerous form; `safe` bundles are the documented
 * safe form. Both projects start from the same base schema bundle.
 *
 * build-fixtures.ts turns these into real `<ULID>_<slug>/` directories with
 * `exponetdb migration new` (so ULIDs, dependsOn and the manifest follow the
 * product's own template) and then fills in the files.
 */
export interface Spec {
  /** Stable id used by the matrix and the analysis tool (also the slug prefix). */
  readonly id: string
  readonly slug: string
  readonly description: string
  readonly transactional?: boolean
  /** The class the author declares (the observed class decides if it is understated). */
  readonly declared?: 'additive' | 'potentially_breaking' | 'data_rewrite' | 'destructive'
  readonly statementTimeout?: string
  readonly lockTimeout?: string
  readonly up: string
  /** Statement indexes verify.sql claims to cover (`-- covers:`). */
  readonly covers?: readonly number[]
  readonly verify?: string
}

const BASE_UP = `-- Base schema of the DDL hazard fixtures: a small shop. Tables carry the
-- columns the hazard bundles change (customer_id is nullable on purpose).
CREATE TYPE public.order_status AS ENUM ('new', 'paid', 'shipped');

CREATE TABLE public.customers (
  id bigint PRIMARY KEY,
  email text NOT NULL
);

CREATE TABLE public.orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint,
  ref text,
  status public.order_status NOT NULL DEFAULT 'new',
  amount integer NOT NULL,
  note varchar(200),
  legacy_ref text,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload jsonb
);

CREATE INDEX idx_orders_old ON public.orders (note);

CREATE TABLE public.order_items (
  id bigint PRIMARY KEY,
  order_id bigint NOT NULL,
  sku text NOT NULL,
  qty integer NOT NULL
);

CREATE TABLE public.audit_log (
  id bigint PRIMARY KEY,
  at timestamptz NOT NULL,
  message text NOT NULL
);

CREATE TABLE public.events (
  id bigint NOT NULL,
  happened_at timestamptz NOT NULL,
  kind text NOT NULL
) PARTITION BY RANGE (happened_at);

CREATE TABLE public.events_2026_10 PARTITION OF public.events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE TABLE public.events_2026_11 (
  id bigint NOT NULL,
  happened_at timestamptz NOT NULL,
  kind text NOT NULL
);

CREATE VIEW public.open_orders AS
  SELECT id, customer_id, status FROM public.orders WHERE status <> 'shipped';

CREATE MATERIALIZED VIEW public.order_totals AS
  SELECT customer_id, count(*) AS n FROM public.orders GROUP BY customer_id;

CREATE FUNCTION public.audit_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RETURN NEW;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers, public.orders, public.order_items,
  public.audit_log, public.events, public.events_2026_10, public.events_2026_11 TO shop_app;
`

const BASE: Spec = {
  id: 'h00',
  slug: 'base-shop-schema',
  description: 'The shop schema every other fixture changes: orders, order_items, events, a view and a materialized view.',
  declared: 'additive',
  up: BASE_UP,
  covers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
}

const BASE_IDX: Spec = {
  id: 'h00b',
  slug: 'order-totals-unique-index',
  description: 'Unique index on the order totals so REFRESH ... CONCURRENTLY works; built concurrently like any index.',
  transactional: false,
  declared: 'potentially_breaking',
  up: 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS order_totals_pk ON public.order_totals (customer_id);\n',
}

const tbl = 'public.orders'

export const HAZARD: readonly Spec[] = [
  BASE,
  BASE_IDX,
  {
    id: 'h01', slug: 'create-index-plain',
    description: 'Index the orders by customer. Plain CREATE INDEX: SHARE lock for the whole build.',
    up: `CREATE INDEX idx_orders_customer ON ${tbl} (customer_id);\n`,
  },
  {
    id: 'h02', slug: 'cic-in-transactional-bundle',
    description: 'CREATE INDEX CONCURRENTLY in a bundle that is declared transactional.',
    up: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status ON ${tbl} (status);\n`,
  },
  {
    id: 'h03', slug: 'cic-two-statements',
    description: 'Two concurrent index builds in one non-transactional bundle (a failure leaves a half-done state).',
    transactional: false,
    up:
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_created ON ${tbl} (created_at);\n` +
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_ref ON ${tbl} (ref);\n`,
  },
  {
    id: 'h04', slug: 'add-column-volatile-uuid',
    description: 'Public id for the orders: gen_random_uuid() is volatile, so every row is rewritten.',
    declared: 'data_rewrite',
    up: `ALTER TABLE ${tbl} ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid();\n`,
  },
  {
    id: 'h05', slug: 'add-column-const-default',
    description: 'Archived flag with a constant default: PostgreSQL 11 and later add it without a rewrite.',
    up: `ALTER TABLE ${tbl} ADD COLUMN archived boolean NOT NULL DEFAULT false;\n`,
  },
  {
    id: 'h06', slug: 'add-column-now-default',
    description: 'Updated-at column with DEFAULT now(): now() is stable, so there is no rewrite on PostgreSQL 11 and later.',
    up: `ALTER TABLE ${tbl} ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();\n`,
  },
  {
    id: 'h07', slug: 'add-column-immutable-fn',
    description: 'Slug column with an immutable function default: no rewrite, the value is computed once.',
    up: `ALTER TABLE ${tbl} ADD COLUMN slug text NOT NULL DEFAULT lower('NEW');\n`,
  },
  {
    id: 'h08', slug: 'add-column-bigserial',
    description: 'Sequence number column as bigserial: nextval() is volatile, PostgreSQL rewrites the table.',
    up: `ALTER TABLE ${tbl} ADD COLUMN seq bigserial;\n`,
  },
  {
    id: 'h09', slug: 'add-column-identity',
    description: 'Line number as an identity column: backed by nextval(), PostgreSQL rewrites the table.',
    up: `ALTER TABLE ${tbl} ADD COLUMN line_no bigint GENERATED ALWAYS AS IDENTITY;\n`,
  },
  {
    id: 'h10', slug: 'add-column-generated-stored',
    description: 'Cents as a stored generated column: computed for every row, a full rewrite.',
    declared: 'data_rewrite',
    up: `ALTER TABLE ${tbl} ADD COLUMN amount_cents bigint GENERATED ALWAYS AS (amount::bigint * 100) STORED;\n`,
  },
  {
    id: 'h11', slug: 'alter-type-int-to-numeric',
    description: 'Amount becomes numeric(12,2): integer to numeric is not binary coercible, a full rewrite.',
    declared: 'data_rewrite',
    up: `ALTER TABLE ${tbl} ALTER COLUMN amount TYPE numeric(12,2);\n`,
  },
  {
    id: 'h12', slug: 'alter-type-varchar-widen',
    description: 'Note grows from varchar(200) to varchar(500): widening a varchar needs no rewrite.',
    declared: 'data_rewrite',
    up: `ALTER TABLE ${tbl} ALTER COLUMN note TYPE varchar(500);\n`,
  },
  {
    id: 'h13', slug: 'alter-type-timestamp-tz',
    description: 'Created-at timestamp becomes timestamptz: no rewrite when the session TimeZone is UTC (the engine pins UTC).',
    declared: 'data_rewrite',
    up: `ALTER TABLE ${tbl} ALTER COLUMN created_at TYPE timestamptz;\n`,
  },
  {
    id: 'h14', slug: 'set-not-null',
    description: 'Customer id becomes NOT NULL: a full scan under ACCESS EXCLUSIVE.',
    declared: 'potentially_breaking',
    up: `ALTER TABLE ${tbl} ALTER COLUMN customer_id SET NOT NULL;\n`,
  },
  {
    id: 'h15', slug: 'add-check-validated',
    description: 'Amounts must not be negative: a validated CHECK scans the table under ACCESS EXCLUSIVE.',
    declared: 'potentially_breaking',
    up: `ALTER TABLE ${tbl} ADD CONSTRAINT orders_amount_pos CHECK (amount >= 0);\n`,
  },
  {
    id: 'h16', slug: 'add-fk-validated',
    description: 'Items reference orders: a validated foreign key scans the child under SHARE ROW EXCLUSIVE on both tables.',
    declared: 'potentially_breaking',
    up: 'ALTER TABLE public.order_items ADD CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES public.orders (id);\n',
  },
  {
    id: 'h17', slug: 'add-unique-constraint',
    description: 'Order refs must be unique: ADD CONSTRAINT UNIQUE builds its index under ACCESS EXCLUSIVE.',
    declared: 'potentially_breaking',
    up: `ALTER TABLE ${tbl} ADD CONSTRAINT orders_ref_key UNIQUE (ref);\n`,
  },
  {
    id: 'h18', slug: 'enum-add-value-and-use',
    description: 'Add the refunded status and use it in the same bundle (PostgreSQL refuses the use before commit).',
    declared: 'data_rewrite',
    up:
      `ALTER TYPE public.order_status ADD VALUE 'refunded';\n` +
      `UPDATE ${tbl} SET status = 'refunded' WHERE ref = 'R-0';\n`,
    covers: [1],
  },
  {
    id: 'h19', slug: 'enum-add-value-alone',
    description: 'Add the cancelled status; nothing uses it yet.',
    up: `ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'cancelled';\n`,
    covers: [0],
  },
  {
    id: 'h20', slug: 'enum-rename-value',
    description: 'Rename the status new to created: code that compares with the old label breaks.',
    declared: 'potentially_breaking',
    up: `ALTER TYPE public.order_status RENAME VALUE 'new' TO 'created';\n`,
  },
  {
    id: 'h21', slug: 'drop-column',
    description: 'Drop legacy_ref while a running build may still read it.',
    declared: 'destructive',
    up: `ALTER TABLE ${tbl} DROP COLUMN legacy_ref;\n`,
  },
  {
    id: 'h22', slug: 'rename-column',
    description: 'Rename note to memo in place.',
    declared: 'potentially_breaking',
    up: `ALTER TABLE ${tbl} RENAME COLUMN note TO memo;\n`,
  },
  {
    id: 'h23', slug: 'rename-table',
    description: 'Rename order_items to order_lines in place.',
    declared: 'potentially_breaking',
    up: 'ALTER TABLE public.order_items RENAME TO order_lines;\n',
  },
  {
    id: 'h24', slug: 'lock-held-across-backfill',
    description: 'Add a column and backfill it in the same transaction: ACCESS EXCLUSIVE is held until the backfill commits.',
    declared: 'data_rewrite',
    up:
      `ALTER TABLE ${tbl} ADD COLUMN region text;\n` +
      `UPDATE ${tbl} SET region = 'eu' WHERE created_at >= '2000-01-01';\n`,
    covers: [1],
  },
  {
    id: 'h25', slug: 'update-no-where',
    description: 'Normalize notes with one UPDATE over the whole table.',
    declared: 'data_rewrite',
    up: `UPDATE ${tbl} SET note = lower(note);\n`,
    covers: [0],
  },
  {
    id: 'h26', slug: 'update-where-true-ish',
    description: 'Reset payload with a predicate that matches every row.',
    declared: 'data_rewrite',
    up: `UPDATE ${tbl} SET payload = '{}'::jsonb WHERE id > 0;\n`,
    covers: [0],
  },
  {
    id: 'h27', slug: 'truncate-table',
    description: 'Empty the audit log with TRUNCATE (ACCESS EXCLUSIVE, no row-level undo).',
    declared: 'destructive',
    up: 'TRUNCATE public.audit_log;\n',
    covers: [0],
  },
  {
    id: 'h28', slug: 'create-trigger',
    description: 'Audit trigger on the hot orders table: SHARE ROW EXCLUSIVE, then a function call per row.',
    declared: 'potentially_breaking',
    up: `CREATE TRIGGER orders_audit AFTER INSERT OR UPDATE ON ${tbl} FOR EACH ROW EXECUTE FUNCTION public.audit_row();\n`,
  },
  {
    id: 'h29', slug: 'create-policy',
    description: 'Row policy on the orders for the app role.',
    up: `CREATE POLICY orders_app_select ON ${tbl} FOR SELECT TO shop_app USING (customer_id IS NOT NULL);\n`,
  },
  {
    id: 'h30', slug: 'enable-rls',
    description: 'Enable row level security on the orders (no policy in this bundle: non-owner roles see no rows).',
    declared: 'potentially_breaking',
    up: `ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY;\n`,
  },
  {
    id: 'h31', slug: 'alter-extension-update',
    description: 'Update pg_trgm to the newest installed version.',
    declared: 'data_rewrite',
    up: 'ALTER EXTENSION pg_trgm UPDATE;\n',
    covers: [0],
  },
  {
    id: 'h32', slug: 'attach-partition',
    description: 'Attach the November events table as a partition without a prior CHECK constraint.',
    declared: 'potentially_breaking',
    up: "ALTER TABLE public.events ATTACH PARTITION public.events_2026_11 FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');\n",
    covers: [0],
  },
  {
    id: 'h33', slug: 'drop-index-plain',
    description: 'Drop the unused index idx_orders_old: ACCESS EXCLUSIVE on the table.',
    declared: 'potentially_breaking',
    up: 'DROP INDEX public.idx_orders_old;\n',
  },
  {
    id: 'h34', slug: 'reindex-table',
    description: 'Rebuild all indexes of the orders: ACCESS EXCLUSIVE for the whole rebuild.',
    up: `REINDEX TABLE ${tbl};\n`,
    covers: [0],
  },
  {
    id: 'h35', slug: 'vacuum-full',
    description: 'Reclaim space with VACUUM FULL: rewrites the table under ACCESS EXCLUSIVE.',
    transactional: false,
    declared: 'data_rewrite',
    up: `VACUUM FULL ${tbl};\n`,
    covers: [0],
  },
  {
    id: 'h36', slug: 'cluster-table',
    description: 'Physically reorder the orders by primary key with CLUSTER.',
    declared: 'data_rewrite',
    up: `CLUSTER ${tbl} USING orders_pkey;\n`,
    covers: [0],
  },
  {
    id: 'h37', slug: 'set-unlogged',
    description: 'Make the audit log UNLOGGED: rewrites the table and loses its data after a crash.',
    declared: 'data_rewrite',
    up: 'ALTER TABLE public.audit_log SET UNLOGGED;\n',
    covers: [0],
  },
  {
    id: 'h38', slug: 'alter-sequence-restart',
    description: 'Restart the order id sequence at 1.',
    declared: 'potentially_breaking',
    up: 'ALTER SEQUENCE public.orders_id_seq RESTART WITH 1;\n',
    covers: [0],
  },
  {
    id: 'h39', slug: 'replace-view',
    description: 'Add a column to the open_orders view with CREATE OR REPLACE VIEW (ACCESS EXCLUSIVE on the view).',
    declared: 'potentially_breaking',
    up: `CREATE OR REPLACE VIEW public.open_orders AS\n  SELECT id, customer_id, status, ref FROM ${tbl} WHERE status <> 'shipped';\n`,
  },
  {
    id: 'h40', slug: 'refresh-matview',
    description: 'Refresh the order totals: ACCESS EXCLUSIVE on the view for the whole query.',
    declared: 'data_rewrite',
    up: 'REFRESH MATERIALIZED VIEW public.order_totals;\n',
    covers: [0],
  },
  {
    id: 'h42',
    slug: 'not-null-four-steps-one-bundle',
    description:
      'The documented NOT NULL recipe in one transactional bundle: the lock of the first statement is held through the validating scan.',
    declared: 'potentially_breaking',
    up:
      `ALTER TABLE ${tbl} ADD CONSTRAINT orders_customer_nn CHECK (customer_id IS NOT NULL) NOT VALID;\n` +
      `ALTER TABLE ${tbl} VALIDATE CONSTRAINT orders_customer_nn;\n` +
      `ALTER TABLE ${tbl} ALTER COLUMN customer_id SET NOT NULL;\n` +
      `ALTER TABLE ${tbl} DROP CONSTRAINT orders_customer_nn;\n`,
  },
  {
    id: 'h43',
    slug: 'long-lock-timeout',
    description: 'A two hour lock_timeout on a cheap statement (the docs say 60 s is the maximum without an acknowledgement).',
    lockTimeout: '2h',
    up: `ALTER TABLE ${tbl} ADD COLUMN flag2 boolean;\n`,
  },
  {
    id: 'h44',
    slug: 'needless-nontransactional',
    description: 'Non-transactional mode for a statement that runs fine in a transaction.',
    transactional: false,
    up: `ALTER TABLE ${tbl} ADD COLUMN flag3 boolean;\n`,
  },
  {
    id: 'h45',
    slug: 'detach-concurrently-in-tx',
    description: 'Detach the October partition without blocking: DETACH PARTITION CONCURRENTLY, in a transactional bundle.',
    declared: 'destructive',
    up: 'ALTER TABLE public.events DETACH PARTITION public.events_2026_10 CONCURRENTLY;\n',
    covers: [0],
  },
  {
    id: 'h46',
    slug: 'detach-concurrently-nontx',
    description: 'The same detach in a non-transactional bundle, which PostgreSQL requires for CONCURRENTLY.',
    transactional: false,
    declared: 'destructive',
    up: 'ALTER TABLE public.events DETACH PARTITION public.events_2026_10 CONCURRENTLY;\n',
    covers: [0],
  },
]

export const SAFE: readonly Spec[] = [
  BASE,
  BASE_IDX,
  {
    id: 's01', slug: 'create-index-concurrently',
    description: 'Index the orders by customer without blocking writes.',
    transactional: false,
    statementTimeout: '1h',
    up: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_customer ON ${tbl} (customer_id);\n`,
  },
  {
    id: 's02', slug: 'add-column-nullable',
    description: 'Public id as a nullable column without default: metadata only. Backfill runs outside the engine in batches.',
    up: `ALTER TABLE ${tbl} ADD COLUMN public_id uuid;\n`,
  },
  {
    id: 's03', slug: 'set-default-new-rows',
    description: 'Default for new rows only: metadata only, existing rows are not touched.',
    up: `ALTER TABLE ${tbl} ALTER COLUMN public_id SET DEFAULT gen_random_uuid();\n`,
    covers: [0],
  },
  {
    id: 's04', slug: 'add-column-const-default',
    description: 'Archived flag with a constant default: PostgreSQL 11 and later add it without a rewrite.',
    up: `ALTER TABLE ${tbl} ADD COLUMN archived boolean NOT NULL DEFAULT false;\n`,
  },
  {
    id: 's05', slug: 'expand-numeric-amount',
    description: 'Expand step of a type change: a new column; copy, switch reads and drop the old one in later migrations.',
    up: `ALTER TABLE ${tbl} ADD COLUMN amount_num numeric(12,2);\n`,
  },
  {
    id: 's06', slug: 'not-null-step-1-check',
    description: 'NOT NULL in four steps, step 1: a CHECK that is not validated (no scan).',
    declared: 'potentially_breaking',
    up: `ALTER TABLE ${tbl} ADD CONSTRAINT orders_customer_nn CHECK (customer_id IS NOT NULL) NOT VALID;\n`,
  },
  {
    id: 's07', slug: 'not-null-step-2-validate',
    description: 'Step 2: validate the CHECK; only SHARE UPDATE EXCLUSIVE, writes continue.',
    declared: 'potentially_breaking',
    up: `ALTER TABLE ${tbl} VALIDATE CONSTRAINT orders_customer_nn;\n`,
  },
  {
    id: 's08', slug: 'not-null-step-3-set',
    description: 'Step 3 and 4: SET NOT NULL uses the validated CHECK (no scan), then the CHECK is dropped.',
    declared: 'potentially_breaking',
    up:
      `ALTER TABLE ${tbl} ALTER COLUMN customer_id SET NOT NULL;\n` +
      `ALTER TABLE ${tbl} DROP CONSTRAINT orders_customer_nn;\n`,
  },
  {
    id: 's09', slug: 'check-not-valid',
    description: 'Amounts must not be negative, step 1: add the CHECK without validating it.',
    declared: 'potentially_breaking',
    up: `ALTER TABLE ${tbl} ADD CONSTRAINT orders_amount_pos CHECK (amount >= 0) NOT VALID;\n`,
  },
  {
    id: 's10', slug: 'check-validate',
    description: 'Step 2: validate the amount CHECK in its own migration.',
    declared: 'potentially_breaking',
    up: `ALTER TABLE ${tbl} VALIDATE CONSTRAINT orders_amount_pos;\n`,
  },
  {
    id: 's11', slug: 'fk-index-concurrently',
    description: 'Index the foreign key column of the child before the constraint exists.',
    transactional: false,
    statementTimeout: '1h',
    up: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_items_order ON public.order_items (order_id);\n',
  },
  {
    id: 's12', slug: 'fk-not-valid',
    description: 'Items reference orders, step 1: the constraint is added NOT VALID (brief lock, no scan).',
    declared: 'potentially_breaking',
    up: 'ALTER TABLE public.order_items ADD CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES public.orders (id) NOT VALID;\n',
  },
  {
    id: 's13', slug: 'fk-validate',
    description: 'Step 2: validate the foreign key; SHARE UPDATE EXCLUSIVE on the child, writes continue.',
    declared: 'potentially_breaking',
    up: 'ALTER TABLE public.order_items VALIDATE CONSTRAINT order_items_order_fk;\n',
  },
  {
    id: 's14', slug: 'unique-index-concurrently',
    description: 'Order refs must be unique, step 1: build the unique index concurrently.',
    transactional: false,
    statementTimeout: '1h',
    declared: 'potentially_breaking',
    up: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS orders_ref_uidx ON ${tbl} (ref);\n`,
  },
  {
    id: 's15', slug: 'unique-using-index',
    description: 'Step 2: attach the finished index as the constraint; no scan, no rebuild.',
    declared: 'potentially_breaking',
    up: `ALTER TABLE ${tbl} ADD CONSTRAINT orders_ref_key UNIQUE USING INDEX orders_ref_uidx;\n`,
  },
  {
    id: 's16', slug: 'enum-add-value-alone',
    description: 'Add the refunded status; the value is used by a later migration.',
    up: `ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'refunded';\n`,
    covers: [0],
  },
  {
    id: 's17', slug: 'enum-use-value-later',
    description: 'Use the refunded status (a later migration, after the ADD VALUE committed).',
    declared: 'data_rewrite',
    up: `UPDATE ${tbl} SET status = 'refunded' WHERE ref = 'R-0';\n`,
    covers: [0],
  },
  {
    id: 's18', slug: 'drop-column-contract',
    description: 'Contract step: drop legacy_ref after the deployed build stopped reading it.',
    declared: 'destructive',
    lockTimeout: '2s',
    up: `ALTER TABLE ${tbl} DROP COLUMN legacy_ref;\n`,
  },
  {
    id: 's19', slug: 'rename-expand-memo',
    description: 'Expand step of a rename: a new memo column next to note; dual-write, copy, then contract.',
    up: `ALTER TABLE ${tbl} ADD COLUMN memo varchar(500);\n`,
  },
  {
    id: 's20', slug: 'partition-check-not-valid',
    description: 'Attach without a scan, step 1: a CHECK on the new partition that proves its bounds.',
    declared: 'potentially_breaking',
    up: "ALTER TABLE public.events_2026_11 ADD CONSTRAINT events_2026_11_bounds CHECK (happened_at >= '2026-11-01' AND happened_at < '2026-12-01') NOT VALID;\n",
  },
  {
    id: 's21', slug: 'partition-check-validate',
    description: 'Step 2: validate the bounds CHECK on the partition (not yet attached, no traffic).',
    declared: 'potentially_breaking',
    up: 'ALTER TABLE public.events_2026_11 VALIDATE CONSTRAINT events_2026_11_bounds;\n',
  },
  {
    id: 's22', slug: 'partition-attach',
    description: 'Step 3: attach (the validated CHECK replaces the partition scan) and drop the helper CHECK.',
    declared: 'potentially_breaking',
    up:
      "ALTER TABLE public.events ATTACH PARTITION public.events_2026_11 FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');\n" +
      'ALTER TABLE public.events_2026_11 DROP CONSTRAINT events_2026_11_bounds;\n',
    covers: [0],
  },
  {
    id: 's23', slug: 'drop-index-concurrently',
    description: 'Drop the unused index without an ACCESS EXCLUSIVE lock.',
    transactional: false,
    declared: 'potentially_breaking',
    up: 'DROP INDEX CONCURRENTLY IF EXISTS public.idx_orders_old;\n',
  },
  {
    id: 's24', slug: 'reindex-concurrently',
    description: 'Rebuild the indexes of the orders without blocking writes.',
    transactional: false,
    statementTimeout: '1h',
    up: `REINDEX TABLE CONCURRENTLY ${tbl};\n`,
    covers: [0],
  },
  {
    id: 's25', slug: 'vacuum-analyze',
    description: 'Plain VACUUM (ANALYZE) instead of VACUUM FULL: no rewrite, SHARE UPDATE EXCLUSIVE.',
    transactional: false,
    up: `VACUUM (ANALYZE) ${tbl};\n`,
    covers: [0],
  },
  {
    id: 's26', slug: 'enable-rls-with-policy',
    description: 'Enable row level security together with the policy in one transaction: no window without a policy.',
    declared: 'potentially_breaking',
    lockTimeout: '2s',
    up:
      `ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY;\n` +
      `CREATE POLICY orders_app_select ON ${tbl} FOR SELECT TO shop_app USING (customer_id IS NOT NULL);\n`,
  },
  {
    id: 's27', slug: 'create-trigger-short-lock',
    description: 'Audit trigger on the orders with a 2 s lock timeout so it never queues the application for long.',
    declared: 'potentially_breaking',
    lockTimeout: '2s',
    up: `CREATE TRIGGER orders_audit AFTER INSERT OR UPDATE ON ${tbl} FOR EACH ROW EXECUTE FUNCTION public.audit_row();\n`,
  },
  {
    id: 's28', slug: 'new-view-instead-of-replace',
    description: 'A new view name instead of replacing the busy one; callers switch over in their own release.',
    up: `CREATE VIEW public.open_orders_v2 AS\n  SELECT id, customer_id, status, ref FROM ${tbl} WHERE status <> 'shipped';\n`,
  },
  {
    id: 's29', slug: 'refresh-matview-concurrently',
    description: 'Refresh the order totals without blocking readers (needs the unique index order_totals_pk).',
    declared: 'data_rewrite',
    up: 'REFRESH MATERIALIZED VIEW CONCURRENTLY public.order_totals;\n',
    covers: [0],
  },
  {
    id: 's30', slug: 'varchar-widen-no-rewrite',
    description: 'Note grows to varchar(500): no rewrite in PostgreSQL, same statement as the hazard fixture.',
    declared: 'data_rewrite',
    up: `ALTER TABLE ${tbl} ALTER COLUMN note TYPE varchar(500);\n`,
  },
]

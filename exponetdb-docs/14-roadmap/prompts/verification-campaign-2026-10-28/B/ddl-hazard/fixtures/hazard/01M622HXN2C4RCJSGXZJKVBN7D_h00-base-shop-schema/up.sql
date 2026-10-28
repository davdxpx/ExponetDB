-- Base schema of the DDL hazard fixtures: a small shop. Tables carry the
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

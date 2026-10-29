-- additive: a column with a constant default (no rewrite since PostgreSQL 11) and a small marker table
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'app';
CREATE TABLE public.rh_marker (id bigint PRIMARY KEY, ts timestamptz NOT NULL DEFAULT clock_timestamp());
GRANT ALL ON public.rh_marker TO service_role;

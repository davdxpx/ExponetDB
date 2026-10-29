-- medium risk, second index on the hottest table: measured under load (the first index was built before pgbench started)
CREATE INDEX events_log_kind_created_idx ON public.events_log (kind, created_at DESC);

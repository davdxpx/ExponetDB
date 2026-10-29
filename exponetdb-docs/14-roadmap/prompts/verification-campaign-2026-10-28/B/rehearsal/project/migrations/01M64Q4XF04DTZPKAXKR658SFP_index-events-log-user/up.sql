-- medium risk: a plain CREATE INDEX on the hottest table (5M rows) blocks its writers while it builds
CREATE INDEX events_log_user_created_idx ON public.events_log (user_id, created_at DESC);

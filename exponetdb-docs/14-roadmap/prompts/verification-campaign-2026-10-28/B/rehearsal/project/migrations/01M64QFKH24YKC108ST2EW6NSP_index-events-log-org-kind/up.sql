-- medium risk, the measured twin of the earlier index bundle: a plain CREATE INDEX on the hottest table while pgbench writes to it
CREATE INDEX events_log_org_kind_idx ON public.events_log (org_id, kind);

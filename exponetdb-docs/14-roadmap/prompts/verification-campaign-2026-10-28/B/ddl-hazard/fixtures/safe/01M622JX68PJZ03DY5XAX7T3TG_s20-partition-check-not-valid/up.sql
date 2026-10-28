ALTER TABLE public.events_2026_11 ADD CONSTRAINT events_2026_11_bounds CHECK (happened_at >= '2026-11-01' AND happened_at < '2026-12-01') NOT VALID;

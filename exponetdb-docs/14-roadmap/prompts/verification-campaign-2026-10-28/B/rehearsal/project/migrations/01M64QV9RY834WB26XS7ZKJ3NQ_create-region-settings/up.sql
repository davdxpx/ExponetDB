-- the last bundle: the point-in-time restore goes back to just before it
CREATE TABLE public.region_settings (region text PRIMARY KEY, config jsonb NOT NULL DEFAULT '{}'::jsonb);
INSERT INTO public.region_settings (region) VALUES ('eu'), ('us');
GRANT SELECT ON public.region_settings TO authenticated;

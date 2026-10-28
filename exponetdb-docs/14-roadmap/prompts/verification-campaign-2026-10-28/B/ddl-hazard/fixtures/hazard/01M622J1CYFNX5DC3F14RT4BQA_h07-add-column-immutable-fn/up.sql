ALTER TABLE public.orders ADD COLUMN slug text NOT NULL DEFAULT lower('NEW');

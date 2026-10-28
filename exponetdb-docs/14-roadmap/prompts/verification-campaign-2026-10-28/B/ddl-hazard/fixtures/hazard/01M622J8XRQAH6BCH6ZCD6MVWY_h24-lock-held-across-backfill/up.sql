ALTER TABLE public.orders ADD COLUMN region text;
UPDATE public.orders SET region = 'eu' WHERE created_at >= '2000-01-01';

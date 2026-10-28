ALTER TABLE public.orders ADD CONSTRAINT orders_ref_key UNIQUE USING INDEX orders_ref_uidx;

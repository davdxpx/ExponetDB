ALTER TABLE public.orders ADD CONSTRAINT orders_amount_pos CHECK (amount >= 0);

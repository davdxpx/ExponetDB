ALTER TABLE public.orders ADD CONSTRAINT orders_customer_nn CHECK (customer_id IS NOT NULL) NOT VALID;

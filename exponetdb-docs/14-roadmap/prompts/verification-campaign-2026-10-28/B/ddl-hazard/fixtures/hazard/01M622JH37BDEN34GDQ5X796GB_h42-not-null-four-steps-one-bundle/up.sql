ALTER TABLE public.orders ADD CONSTRAINT orders_customer_nn CHECK (customer_id IS NOT NULL) NOT VALID;
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_customer_nn;
ALTER TABLE public.orders ALTER COLUMN customer_id SET NOT NULL;
ALTER TABLE public.orders DROP CONSTRAINT orders_customer_nn;

ALTER TABLE public.orders ALTER COLUMN customer_id SET NOT NULL;
ALTER TABLE public.orders DROP CONSTRAINT orders_customer_nn;

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_app_select ON public.orders FOR SELECT TO shop_app USING (customer_id IS NOT NULL);

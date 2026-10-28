CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_created ON public.orders (created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_ref ON public.orders (ref);

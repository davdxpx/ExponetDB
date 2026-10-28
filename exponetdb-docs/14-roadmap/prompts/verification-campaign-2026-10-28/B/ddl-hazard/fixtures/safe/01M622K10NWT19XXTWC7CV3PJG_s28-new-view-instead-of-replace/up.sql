CREATE VIEW public.open_orders_v2 AS
  SELECT id, customer_id, status, ref FROM public.orders WHERE status <> 'shipped';

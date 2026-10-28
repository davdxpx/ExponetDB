CREATE OR REPLACE VIEW public.open_orders AS
  SELECT id, customer_id, status, ref FROM public.orders WHERE status <> 'shipped';

ALTER TYPE public.order_status ADD VALUE 'refunded';
UPDATE public.orders SET status = 'refunded' WHERE ref = 'R-0';

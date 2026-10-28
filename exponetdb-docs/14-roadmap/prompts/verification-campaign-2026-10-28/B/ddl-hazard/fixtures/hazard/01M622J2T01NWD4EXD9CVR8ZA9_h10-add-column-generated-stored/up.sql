ALTER TABLE public.orders ADD COLUMN amount_cents bigint GENERATED ALWAYS AS (amount::bigint * 100) STORED;

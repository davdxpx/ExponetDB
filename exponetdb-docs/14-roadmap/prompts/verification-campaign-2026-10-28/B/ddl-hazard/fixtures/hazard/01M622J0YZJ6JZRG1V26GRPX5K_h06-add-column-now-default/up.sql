ALTER TABLE public.orders ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

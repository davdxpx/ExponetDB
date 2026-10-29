-- low risk: a nullable column without default is a catalog-only change
ALTER TABLE public.crm_items ADD COLUMN IF NOT EXISTS note text;
COMMENT ON COLUMN public.crm_items.note IS 'free text note of the account manager';

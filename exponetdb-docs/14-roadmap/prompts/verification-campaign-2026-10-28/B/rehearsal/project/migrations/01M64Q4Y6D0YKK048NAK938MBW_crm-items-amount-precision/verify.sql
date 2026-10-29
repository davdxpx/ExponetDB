SELECT (SELECT numeric_precision FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_items' AND column_name='amount') = 16 AS ok;

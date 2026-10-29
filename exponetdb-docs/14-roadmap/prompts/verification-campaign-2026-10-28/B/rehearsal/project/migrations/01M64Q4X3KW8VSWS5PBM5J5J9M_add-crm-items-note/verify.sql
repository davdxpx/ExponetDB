SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_items' AND column_name='note') AS ok;

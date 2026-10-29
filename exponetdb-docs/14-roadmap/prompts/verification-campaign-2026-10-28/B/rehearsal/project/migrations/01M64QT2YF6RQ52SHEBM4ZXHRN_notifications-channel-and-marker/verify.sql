SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='notifications' AND column_name='channel') AND to_regclass('public.rh_marker') IS NOT NULL AS ok;

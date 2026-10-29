SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='hr_accounts' AND column_name='flag') AS ok;

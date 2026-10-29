SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname='public' AND indexname='events_log_user_created_idx') AS ok;

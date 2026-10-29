SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname=$$public$$ AND indexname=$$events_log_kind_created_idx$$) AS ok;

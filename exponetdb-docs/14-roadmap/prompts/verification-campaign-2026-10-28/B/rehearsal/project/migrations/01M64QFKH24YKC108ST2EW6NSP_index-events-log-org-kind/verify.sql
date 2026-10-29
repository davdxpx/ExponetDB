SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname=$$public$$ AND indexname=$$events_log_org_kind_idx$$) AS ok;

SELECT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='public.feature_usage'::regclass) AS ok;

-- ENGINE_SETTINGS (packages/postgres/src/parser/migration.ts:116) refuses SET / set_config of these names at the
-- top level, but a function body is text and the post-statement guard (EngineGuards, migration-facts.ts:240)
-- reads only 13 settings. Each statement below is APPLIED and the changed value lives on for the rest of the
-- transaction: row_security, extra_float_digits, application_name, default_tablespace, temp_tablespaces,
-- default_transaction_read_only, transaction_timeout (PostgreSQL 17+).
DO $$ BEGIN PERFORM set_config('row_security', 'off', true); END $$;
DO $$ BEGIN PERFORM set_config('extra_float_digits', '-15', true); END $$;
DO $$ BEGIN PERFORM set_config('application_name', 'not-exponetdb', true); END $$;
DO $$ BEGIN PERFORM set_config('transaction_timeout', '0', true); END $$;

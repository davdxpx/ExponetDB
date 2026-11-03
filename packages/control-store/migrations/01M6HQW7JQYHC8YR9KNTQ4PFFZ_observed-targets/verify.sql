-- check: endpoints carry an optional login suffix, for poolers only
SELECT EXISTS (SELECT FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = 'registry.endpoints'::regclass AND a.attname = 'login_suffix'
                  AND NOT a.attnotnull AND NOT a.attisdropped)
       AND EXISTS (SELECT FROM pg_catalog.pg_constraint c
                    WHERE c.conrelid = 'registry.endpoints'::regclass
                      AND c.conname = 'endpoints_login_suffix_pooler') AS ok;

-- check: targets carry a mode, managed by default
SELECT EXISTS (SELECT FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = 'registry.targets'::regclass AND a.attname = 'mode'
                  AND a.attnotnull AND NOT a.attisdropped)
       AND NOT EXISTS (SELECT FROM registry.targets WHERE mode NOT IN ('managed', 'observed')) AS ok;

-- check: the guards keep the suffix and the mode, and an observed target never becomes active
SELECT pg_get_functiondef('registry.endpoint_guard()'::regprocedure) LIKE '%login_suffix%'
   AND pg_get_functiondef('registry.target_guard()'::regprocedure) LIKE '%OLD.mode%'
   AND pg_get_functiondef('registry.target_guard()'::regprocedure) LIKE '%an observed target stays registered%'
   AND EXISTS (SELECT FROM pg_catalog.pg_trigger t
                WHERE t.tgrelid = 'registry.targets'::regclass AND t.tgname = 'targets_guard' AND t.tgenabled = 'O')
   AND EXISTS (SELECT FROM pg_catalog.pg_trigger t
                WHERE t.tgrelid = 'registry.endpoints'::regclass AND t.tgname = 'endpoints_guard' AND t.tgenabled = 'O') AS ok;

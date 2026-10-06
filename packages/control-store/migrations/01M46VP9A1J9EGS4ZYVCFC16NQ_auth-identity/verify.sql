-- These checks state invariants that later, additive bundles keep: named
-- objects exist and behave, forbidden privileges are absent. They never pin
-- the total number of tables, triggers or rows of the schema.

-- check: the auth schema is owned by exdb_migrate and usable only by serve and worker
SELECT n.nspowner = 'exdb_migrate'::regrole
       AND has_schema_privilege('exdb_serve', 'auth', 'USAGE')
       AND has_schema_privilege('exdb_worker', 'auth', 'USAGE')
       AND NOT has_schema_privilege('exdb_gateway', 'auth', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'auth', 'USAGE')
       AND NOT has_schema_privilege('public', 'auth', 'USAGE') AS ok
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'auth';

-- check: every identity table exists and belongs to exdb_migrate
SELECT count(*) = 12 AS ok
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'auth'::regnamespace AND c.relkind = 'r'
   AND c.relowner = 'exdb_migrate'::regrole
   AND c.relname IN ('identity_providers', 'identities', 'external_subjects', 'factors', 'recovery_codes',
                     'capabilities', 'web_sessions', 'reauth_events', 'challenges', 'rate_limits',
                     'notifications', 'installation_keys');

-- check: no column can hold a bearer secret in plaintext (only hashes, references and public values)
SELECT NOT EXISTS (
         SELECT FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          WHERE c.relnamespace = 'auth'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname ~ '(token|secret|password|code|csrf|handle|cookie|otp|key)'
            AND a.attname !~ '_(hash|id|version|index|step)$'
            AND a.attname NOT IN ('webauthn_user_handle', 'webauthn_challenge', 'error_code', 'public_key',
                                  'secret_generation')) AS ok;

-- check: identity states, link lifetimes, session lifetime and ceremony lifetimes are constrained
SELECT bool_and(found) AS ok FROM (
  SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'auth.identities'::regclass AND k.contype = 'c'
                   AND pg_get_constraintdef(k.oid) LIKE '%invited%active%disabled%erased%') AS found
  UNION ALL
  SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'auth.capabilities'::regclass AND k.contype = 'c'
                   AND pg_get_constraintdef(k.oid) LIKE '%24:00:00%' AND pg_get_constraintdef(k.oid) LIKE '%00:30:00%')
  UNION ALL
  SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'auth.web_sessions'::regclass AND k.contype = 'c'
                   AND pg_get_constraintdef(k.oid) LIKE '%absolute_expires_at = (created_at + ''12:00:00''::interval)%')
  UNION ALL
  SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'auth.challenges'::regclass AND k.contype = 'c'
                   AND pg_get_constraintdef(k.oid) LIKE '%00:05:00%')
) checks;

-- check: uniqueness rules are partial unique indexes (one pending bootstrap owner, one live link per kind, one password, one active TOTP)
SELECT count(*) = 7 AS ok
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid
 WHERE x.relnamespace = 'auth'::regnamespace AND i.indisunique AND i.indpred IS NOT NULL
   AND x.relname IN ('identities_email', 'identities_one_pending_bootstrap', 'capabilities_one_live',
                     'factors_one_password', 'factors_one_active_totp', 'factors_one_pending_totp',
                     'web_sessions_reauth_event');

-- check: guard and append-only triggers are enabled
SELECT count(*) = 20 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid::regclass::text LIKE 'auth.%' AND NOT t.tgisinternal AND t.tgenabled = 'O'
   AND t.tgname IN ('identity_providers_append_only', 'identities_guard', 'identities_no_delete',
                    'external_subjects_guard', 'external_subjects_no_update', 'factors_guard',
                    'recovery_codes_guard', 'capabilities_guard', 'capabilities_no_delete',
                    'web_sessions_guard', 'web_sessions_no_delete', 'reauth_events_time',
                    'reauth_events_append_only', 'challenges_guard', 'notifications_no_delete',
                    'installation_keys_append_only', 'identities_no_truncate', 'factors_no_truncate',
                    'web_sessions_no_truncate', 'reauth_events_no_truncate');

-- check: the worker never reads a password hash, a token or CSRF hash, a link hash, an e-mail address or a name
SELECT NOT has_column_privilege('exdb_worker', 'auth.factors', 'password_hash', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'auth.factors', 'public_key', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'auth.web_sessions', 'token_hash', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'auth.web_sessions', 'csrf_hash', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'auth.capabilities', 'token_hash', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'auth.identities', 'email', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'auth.identities', 'display_name', 'SELECT')
       AND NOT has_table_privilege('exdb_worker', 'auth.recovery_codes', 'SELECT')
       AND NOT has_table_privilege('exdb_worker', 'auth.installation_keys', 'SELECT') AS ok;

-- check: serve cannot erase or enable identities by itself, nor change authorization revisions, nor delete history
SELECT NOT has_column_privilege('exdb_serve', 'auth.identities', 'authz_revision', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'auth.identities', 'webauthn_user_handle', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'auth.identities', 'DELETE')
       AND NOT has_table_privilege('exdb_serve', 'auth.web_sessions', 'DELETE')
       AND NOT has_table_privilege('exdb_serve', 'auth.capabilities', 'DELETE')
       AND NOT has_table_privilege('exdb_serve', 'auth.external_subjects', 'INSERT')
       AND NOT has_table_privilege('exdb_worker', 'auth.external_subjects', 'INSERT')
       AND NOT has_table_privilege('exdb_serve', 'auth.reauth_events', 'UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'auth.reauth_events', 'INSERT') AS ok;

-- check: no runtime login may truncate an auth table
SELECT bool_and(NOT has_table_privilege(r, c.oid, 'TRUNCATE')) AS ok
  FROM pg_catalog.pg_class c,
       unnest(ARRAY['exdb_serve', 'exdb_worker', 'exdb_gateway', 'exdb_audit_maint']) AS r
 WHERE c.relnamespace = 'auth'::regnamespace AND c.relkind = 'r';

-- check: PUBLIC holds nothing in the auth schema
SELECT NOT EXISTS (
         SELECT FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
          WHERE c.relnamespace = 'auth'::regnamespace AND a.grantee = 0)
       AND NOT EXISTS (
         SELECT FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'auth'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')) AS ok;

-- check: local authentication is the enabled provider
SELECT EXISTS (SELECT FROM auth.identity_providers p WHERE p.provider_id = 'local' AND p.kind = 'local' AND p.enabled) AS ok;

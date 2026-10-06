-- These checks state invariants that later, additive bundles keep: named
-- objects exist and behave, forbidden privileges are absent. They never pin
-- the total number of tables, triggers or rows of the schema.

-- check: the oauth schema is owned by exdb_migrate and usable only by serve and worker
SELECT n.nspowner = 'exdb_migrate'::regrole
       AND has_schema_privilege('exdb_serve', 'oauth', 'USAGE')
       AND has_schema_privilege('exdb_worker', 'oauth', 'USAGE')
       AND NOT has_schema_privilege('exdb_gateway', 'oauth', 'USAGE')
       AND NOT has_schema_privilege('exdb_audit_maint', 'oauth', 'USAGE')
       AND NOT has_schema_privilege('public', 'oauth', 'USAGE') AS ok
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'oauth';

-- check: every delegation table exists and belongs to exdb_migrate
SELECT count(*) = 11 AS ok
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'oauth'::regnamespace AND c.relkind = 'r'
   AND c.relowner = 'exdb_migrate'::regrole
   AND c.relname IN ('scopes', 'clients', 'service_accounts', 'grants', 'authorization_requests',
                     'authorization_codes', 'tokens', 'device_codes', 'client_assertions', 'api_keys',
                     'rate_limits');

-- check: no column can hold a bearer secret in plaintext (only hashes, references and public values)
SELECT NOT EXISTS (
         SELECT FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          WHERE c.relnamespace = 'oauth'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname ~ '(token|secret|password|code|csrf|handle|cookie|otp|key|jti|assertion|verifier)'
            AND a.attname !~ '_(hash|id|version|index|step)$'
            AND a.attname NOT IN ('code_challenge', 'token_endpoint_auth_method')) AS ok;

-- check: lifetimes are constrained: access tokens 10 minutes, codes 60 seconds, requests and device codes 10 minutes, grants 90 or 365 days, API keys 365 days
SELECT bool_and(found) AS ok FROM (
  SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'oauth.tokens'::regclass AND k.contype = 'c'
                   AND pg_get_constraintdef(k.oid) LIKE '%access%00:10:00%') AS found
  UNION ALL
  SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'oauth.authorization_codes'::regclass
                   AND k.contype = 'c' AND pg_get_constraintdef(k.oid) LIKE '%00:01:00%')
  UNION ALL
  SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'oauth.authorization_requests'::regclass
                   AND k.contype = 'c' AND pg_get_constraintdef(k.oid) LIKE '%00:10:00%')
  UNION ALL
  SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'oauth.device_codes'::regclass
                   AND k.contype = 'c' AND pg_get_constraintdef(k.oid) LIKE '%00:10:00%')
  UNION ALL
  SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'oauth.grants'::regclass AND k.contype = 'c'
                   AND pg_get_constraintdef(k.oid) LIKE '%365 days%' AND pg_get_constraintdef(k.oid) LIKE '%90 days%')
  UNION ALL
  SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'oauth.api_keys'::regclass AND k.contype = 'c'
                   AND pg_get_constraintdef(k.oid) LIKE '%expires_at <= (created_at + ''365 days''::interval)%')
  UNION ALL
  SELECT a.attnotnull FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'oauth.api_keys'::regclass AND a.attname = 'expires_at'
) checks;

-- check: at most one live refresh token per grant, one live machine grant per client, one client per service account
SELECT count(*) = 3 AS ok
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid
 WHERE x.relnamespace = 'oauth'::regnamespace AND i.indisunique AND i.indpred IS NOT NULL
   AND x.relname IN ('tokens_one_live_refresh', 'grants_one_active_machine', 'clients_one_per_service_identity');

-- check: the guard, lifecycle and append-only triggers are enabled
SELECT count(*) = 26 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
   AND (t.tgrelid, t.tgname) IN (
     ('oauth.scopes'::regclass, 'scopes_append_only'),
     ('oauth.scopes'::regclass, 'scopes_no_truncate'),
     ('oauth.clients'::regclass, 'clients_guard'),
     ('oauth.clients'::regclass, 'clients_no_truncate'),
     ('oauth.clients'::regclass, 'clients_left_active'),
     ('oauth.service_accounts'::regclass, 'service_accounts_guard'),
     ('oauth.service_accounts'::regclass, 'service_accounts_append_only'),
     ('oauth.grants'::regclass, 'grants_guard'),
     ('oauth.grants'::regclass, 'grants_no_delete'),
     ('oauth.grants'::regclass, 'grants_revoked'),
     ('oauth.authorization_requests'::regclass, 'authorization_requests_guard'),
     ('oauth.authorization_codes'::regclass, 'authorization_codes_guard'),
     ('oauth.tokens'::regclass, 'tokens_guard'),
     ('oauth.tokens'::regclass, 'tokens_no_truncate'),
     ('oauth.device_codes'::regclass, 'device_codes_guard'),
     ('oauth.client_assertions'::regclass, 'client_assertions_guard'),
     ('oauth.client_assertions'::regclass, 'client_assertions_no_update'),
     ('oauth.api_keys'::regclass, 'api_keys_guard'),
     ('oauth.api_keys'::regclass, 'api_keys_no_delete'),
     ('oauth.api_keys'::regclass, 'api_keys_no_truncate'),
     ('oauth.rate_limits'::regclass, 'rate_limits_no_truncate'),
     ('auth.web_sessions'::regclass, 'web_sessions_human_only'),
     ('auth.factors'::regclass, 'factors_human_only'),
     ('auth.capabilities'::regclass, 'capabilities_human_only'),
     ('auth.role_bindings'::regclass, 'role_bindings_no_service_owner'),
     ('auth.identities'::regclass, 'identities_left_active'));

-- check: the scope catalog holds no session-only scope and keeps every admin and human-only scope away from MCP clients and service accounts
SELECT NOT EXISTS (SELECT FROM oauth.scopes WHERE scope IN ('api', 'plans.approve'))
       AND NOT EXISTS (SELECT FROM oauth.scopes WHERE scope ~ '[*?%]' OR scope = '' )
       AND NOT EXISTS (SELECT FROM oauth.scopes WHERE human_only AND client_kinds <> ARRAY['cli'])
       AND NOT EXISTS (SELECT FROM oauth.scopes
                        WHERE scope IN ('registry.manage', 'access.manage', 'access.read', 'policy.manage',
                                        'restore.execute', 'breakglass.activate', 'diagnostics.read_sensitive',
                                        'data.read_sensitive', 'migrations.import', 'schema.manage',
                                        'operations.recover')
                          AND (mcp_grantable OR 'mcp' = ANY (client_kinds) OR 'ci' = ANY (client_kinds)))
       AND (SELECT count(*) FROM oauth.scopes WHERE scope ~ ':prod$') = 4
       AND (SELECT count(*) FROM oauth.scopes WHERE scope ~ ':nonprod$') = 4 AS ok;

-- check: every production and human-only scope needs explicit consent, and the device flow refuses every such scope
SELECT NOT EXISTS (SELECT FROM oauth.scopes WHERE (tier = 'prod' OR human_only) AND NOT explicit_consent)
       AND (SELECT count(*) FROM oauth.scopes WHERE explicit_consent) = 15
       AND NOT oauth.scopes_device_flow(ARRAY['targets.read', 'data.read:prod'])
       AND NOT oauth.scopes_device_flow(ARRAY['registry.manage'])
       AND oauth.scopes_device_flow(ARRAY['targets.read', 'migrations.apply:nonprod']) AS ok;

-- check: an MCP client holds the MCP resource only and every other client kind the REST resource only
SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'oauth.grants'::regclass AND k.contype = 'c'
                AND pg_get_constraintdef(k.oid) LIKE '%(client_kind = ''mcp''::text) = (resource = ''mcp''::text)%')
       AND NOT EXISTS (SELECT FROM oauth.grants WHERE (client_kind = 'mcp') <> (resource = 'mcp')) AS ok;

-- check: the first-party Web App and CLI are active public clients; the Web App holds no grant type, the CLI only loopback redirects
SELECT EXISTS (SELECT FROM oauth.clients WHERE external_id = 'exponetdb-web' AND registration = 'first_party'
                AND kind = 'web' AND state = 'active' AND token_endpoint_auth_method = 'none'
                AND cardinality(grant_types) = 0 AND cardinality(redirect_uris) = 0)
       AND EXISTS (SELECT FROM oauth.clients WHERE external_id = 'exponetdb-cli' AND registration = 'first_party'
                    AND kind = 'cli' AND state = 'active' AND token_endpoint_auth_method = 'none'
                    AND 'urn:ietf:params:oauth:grant-type:device_code' = ANY (grant_types)
                    AND NOT EXISTS (SELECT FROM unnest(redirect_uris) u WHERE u !~ '^http://(127\.0\.0\.1|\[::1\])/')) AS ok;

-- check: registrations fix the authentication method: CIMD and DCR are public (none), service accounts use private_key_jwt; no shared secret method exists
SELECT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'oauth.clients'::regclass AND k.contype = 'c'
                AND pg_get_constraintdef(k.oid) LIKE '%cimd%dcr%mcp%none%')
       AND EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'oauth.clients'::regclass AND k.contype = 'c'
                    AND pg_get_constraintdef(k.oid) LIKE '%pre_registered%ci%private_key_jwt%')
       AND NOT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'oauth.clients'::regclass
                        AND pg_get_constraintdef(k.oid) LIKE '%client_secret%') AS ok;

-- check: the worker reads no secret hash, binding, client key or API key, and changes nothing but pruning
SELECT NOT has_column_privilege('exdb_worker', 'oauth.tokens', 'token_hash', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'oauth.authorization_codes', 'code_hash', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'oauth.authorization_requests', 'handle_hash', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'oauth.authorization_requests', 'binding_hash', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'oauth.device_codes', 'device_code_hash', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'oauth.device_codes', 'user_code_hash', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'oauth.client_assertions', 'jti_hash', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'oauth.clients', 'jwks', 'SELECT')
       AND NOT has_table_privilege('exdb_worker', 'oauth.api_keys', 'SELECT, INSERT, UPDATE, DELETE')
       AND NOT has_table_privilege('exdb_worker', 'oauth.grants', 'INSERT, UPDATE, DELETE')
       AND NOT has_table_privilege('exdb_worker', 'oauth.tokens', 'INSERT, UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'oauth.clients', 'INSERT, UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'oauth.service_accounts', 'INSERT, UPDATE, DELETE') AS ok;

-- check: serve cannot delete history, rewrite a secret hash, widen a grant or key, or extend the scope catalog
SELECT NOT has_table_privilege('exdb_serve', 'oauth.grants', 'DELETE')
       AND NOT has_table_privilege('exdb_serve', 'oauth.tokens', 'DELETE')
       AND NOT has_table_privilege('exdb_serve', 'oauth.api_keys', 'DELETE')
       AND NOT has_table_privilege('exdb_serve', 'oauth.clients', 'DELETE')
       AND NOT has_table_privilege('exdb_serve', 'oauth.scopes', 'INSERT, UPDATE, DELETE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.tokens', 'token_hash', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.tokens', 'scopes', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.tokens', 'expires_at', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.grants', 'scopes', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.grants', 'tiers', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.grants', 'target_ids', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.grants', 'expires_at', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.api_keys', 'key_hash', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.api_keys', 'scopes', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.api_keys', 'expires_at', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.clients', 'kind', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.clients', 'registration', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.clients', 'token_endpoint_auth_method', 'UPDATE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.authorization_codes', 'code_hash', 'UPDATE') AS ok;

-- check: no runtime login may truncate an oauth table
SELECT bool_and(NOT has_table_privilege(r, c.oid, 'TRUNCATE')) AS ok
  FROM pg_catalog.pg_class c,
       unnest(ARRAY['exdb_serve', 'exdb_worker', 'exdb_gateway', 'exdb_audit_maint']) AS r
 WHERE c.relnamespace = 'oauth'::regnamespace AND c.relkind = 'r';

-- check: PUBLIC holds nothing in the oauth schema; the security definer functions pin their search path
SELECT NOT EXISTS (
         SELECT FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
          WHERE c.relnamespace = 'oauth'::regnamespace AND a.grantee = 0)
       AND NOT EXISTS (
         SELECT FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'oauth'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE'))
       AND NOT EXISTS (
         SELECT FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'oauth'::regnamespace AND p.prosecdef
            AND NOT coalesce('search_path=pg_catalog' = ANY (p.proconfig), false)) AS ok;

-- check: the MCP key purposes are accepted
SELECT pg_get_constraintdef(c.oid) LIKE '%''mcp.cursor_key''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''mcp.request_state_key''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''auth.rate_limit_key''%' AS ok
  FROM pg_catalog.pg_constraint c
 WHERE c.conrelid = 'auth.installation_keys'::regclass
   AND c.conname = 'installation_keys_purpose_check';

-- check: installation keys stay append-only
SELECT count(*) = 2 AS ok
  FROM pg_catalog.pg_trigger t
 WHERE t.tgrelid = 'auth.installation_keys'::regclass
   AND t.tgname IN ('installation_keys_append_only', 'installation_keys_no_truncate')
   AND NOT t.tgisinternal;

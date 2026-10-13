-- check: the last-use table exists with its three columns
SELECT count(*) = 3 AS ok
  FROM information_schema.columns
 WHERE table_schema = 'oauth' AND table_name = 'grant_last_use'
   AND column_name IN ('grant_id', 'last_used_at', 'use_class');

-- check: serve may record a use but never delete one
SELECT has_table_privilege('exdb_serve', 'oauth.grant_last_use', 'INSERT')
       AND has_column_privilege('exdb_serve', 'oauth.grant_last_use', 'last_used_at', 'UPDATE')
       AND NOT has_table_privilege('exdb_serve', 'oauth.grant_last_use', 'DELETE')
       AND NOT has_column_privilege('exdb_serve', 'oauth.grant_last_use', 'grant_id', 'UPDATE') AS ok;

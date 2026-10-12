-- check: the worker reads a grant's scopes and restrictions and still changes no grant column it did not change before
SELECT has_column_privilege('exdb_worker', 'oauth.grants', 'scopes', 'SELECT')
       AND has_column_privilege('exdb_worker', 'oauth.grants', 'tiers', 'SELECT')
       AND has_column_privilege('exdb_worker', 'oauth.grants', 'target_ids', 'SELECT')
       AND NOT has_column_privilege('exdb_worker', 'oauth.grants', 'scopes', 'UPDATE')
       AND NOT has_table_privilege('exdb_worker', 'oauth.grants', 'INSERT')
       AND NOT has_table_privilege('exdb_worker', 'oauth.grants', 'DELETE') AS ok;

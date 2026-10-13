-- check: the guard of oauth.clients admits automatic approval
SELECT pg_get_functiondef('oauth.client_guard()'::regprocedure)
         LIKE '%starts pending or automatically approved%' AS ok;

-- check: the worker reads the columns its prune of unused registrations needs
SELECT has_column_privilege('exdb_worker', 'oauth.authorization_requests', 'client_id', 'SELECT')
   AND has_column_privilege('exdb_worker', 'oauth.clients', 'approved_by_identity_id', 'SELECT')
   AND has_column_privilege('exdb_worker', 'oauth.clients', 'created_at', 'SELECT') AS ok;

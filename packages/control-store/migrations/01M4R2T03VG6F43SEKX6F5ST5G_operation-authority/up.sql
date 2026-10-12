-- The worker's authority re-check of a running operation (operations-engine.md
-- §10, failure case E27). It already reads a grant's identity, client, state
-- and expiry; it also reads which scopes, tiers and targets the grant carries.
-- Never a token: grants hold none.
GRANT SELECT (scopes, tiers, target_ids) ON oauth.grants TO exdb_worker;

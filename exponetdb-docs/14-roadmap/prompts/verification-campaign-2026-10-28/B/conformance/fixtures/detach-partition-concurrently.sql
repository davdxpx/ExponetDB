-- Cannot run inside a transaction block (SQLSTATE 25001). The classifier reports it as ordinary ALTER TABLE:
-- no `nontransactional_statement_in_transactional` in a transactional bundle, and `needless_nontransactional`
-- (blocking) in a non-transactional one, so the engine has no way to express it.
CREATE TABLE p (i int) PARTITION BY RANGE (i);
CREATE TABLE p1 PARTITION OF p FOR VALUES FROM (0) TO (10);
ALTER TABLE p DETACH PARTITION p1 CONCURRENTLY;

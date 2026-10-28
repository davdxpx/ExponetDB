-- Passes lint, runs, commits. While the migration runs, the engine's own session-level advisory locks
-- (key1 = 'EXDB') are gone: pg_locks shows 2 before and 0 after this statement (PostgreSQL 16, 17, 18).
SELECT pg_advisory_unlock_all();
SELECT pg_sleep(4);

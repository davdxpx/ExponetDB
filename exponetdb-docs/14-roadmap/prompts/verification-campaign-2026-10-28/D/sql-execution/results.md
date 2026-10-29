# D2 results: SQL execution safety (sql_query / sql_explain)

Corpus statements run: 607 (x 3 majors = 1821 runs); the 15 resource-limit statements and the limit scenarios are in the sections below.

Verdict tally (per statement and major): ok 1820, over-refused 1

Columns: guard = `admitRead` on the text the worker would send (`EXPLAIN (FORMAT JSON) ...` for explain). server = the statement WITHOUT the guard: R reader in the read-only frame (extended protocol), S superuser in the frame, Ss superuser in the frame over the simple protocol, R0 reader with no frame (simple protocol); `ok(n)` ran, a SQLSTATE is the server error. outcome/layer = the product path (`executeDataRead` on a real reader session). side effect = snapshot difference after the product run or R. Several majors with different values are listed as `major:value`.

| id | class | statement | guard | server | outcome | layer | side effect | verdict |
|---|---|---|---|---|---|---|---|---|
| tx-001 | tx | `SET transaction_read_only = off` | refuse statement_class | R 25001, S 25001, Ss 25001, R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-002 | tx | `SET LOCAL transaction_read_only = off` | refuse statement_class | R 25001, S 25001, Ss 25001, R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-003 | tx | `SET SESSION transaction_read_only = off` | refuse statement_class | R 25001, S 25001, Ss 25001, R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-004 | tx | `SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-005 | tx | `SET default_transaction_read_only = off` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-006 | tx | `SET TRANSACTION READ WRITE` | refuse statement_class | R 25001, S 25001, Ss 25001, R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-007 | tx | `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE READ WRITE` | refuse statement_class | R 25001, S 25001, Ss 25001, R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-008 | tx | `BEGIN READ WRITE` | refuse statement_class | R 25001, S 25001, Ss 25001, R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-009 | tx | `START TRANSACTION READ WRITE` | refuse statement_class | R 25001, S 25001, Ss 25001, R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-010 | tx | `BEGIN` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-011 | tx | `COMMIT` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-012 | tx | `COMMIT AND CHAIN` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 25P01 | NOT_READ_ONLY | guard | no | ok |
| tx-013 | tx | `END` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-014 | tx | `ROLLBACK` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-015 | tx | `ROLLBACK AND CHAIN` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 25P01 | NOT_READ_ONLY | guard | no | ok |
| tx-016 | tx | `ABORT` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-017 | tx | `SAVEPOINT s1` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 25P01 | NOT_READ_ONLY | guard | no | ok |
| tx-018 | tx | `RELEASE SAVEPOINT s1` | refuse statement_class | R 3B001, S 3B001, Ss 3B001, R0 25P01 | NOT_READ_ONLY | guard | no | ok |
| tx-019 | tx | `ROLLBACK TO SAVEPOINT s1` | refuse statement_class | R 3B001, S 3B001, Ss 3B001, R0 25P01 | NOT_READ_ONLY | guard | no | ok |
| tx-020 | tx | `PREPARE TRANSACTION 'd2'` | refuse statement_class | R 55000, S 55000, Ss 55000, R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-021 | tx | `COMMIT PREPARED 'd2'` | refuse statement_class | R 25001, S 25001, Ss 25001, R0 42704 | NOT_READ_ONLY | guard | no | ok |
| tx-022 | tx | `COMMIT; BEGIN READ WRITE; DELETE FROM public.accounts` | refuse multiple_statements | R 42601, S 42601, Ss ok(5), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| tx-023 | tx | `ROLLBACK; SET transaction_read_only = off; DELETE FROM public.accounts` | refuse multiple_statements | R 42601, S 42601, Ss ok(5), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| tx-024 | tx | `SELECT 1; COMMIT; DELETE FROM public.accounts` | refuse multiple_statements | R 42601, S 42601, Ss ok(5), R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| tx-025 | tx | `RESET transaction_read_only` | refuse statement_class | R 0A000, S 0A000, Ss 0A000, R0 0A000 | NOT_READ_ONLY | guard | no | ok |
| tx-026 | tx | `RESET ALL` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-027 | tx | `SET ROLE postgres` | refuse statement_class | R 42501, S ok(0), Ss ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| tx-028 | tx | `SET LOCAL ROLE postgres` | refuse statement_class | R 42501, S ok(0), Ss ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| tx-029 | tx | `SET SESSION AUTHORIZATION postgres` | refuse statement_class | R 42501, S ok(0), Ss ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| tx-030 | tx | `RESET ROLE` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-031 | tx | `RESET SESSION AUTHORIZATION` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-032 | tx | `SET search_path = public` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-033 | tx | `SET LOCAL search_path TO public, pg_catalog` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-034 | tx | `SET statement_timeout = 0` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-035 | tx | `SET LOCAL statement_timeout = 0` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-036 | tx | `SET lock_timeout = 0` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-037 | tx | `SET idle_in_transaction_session_timeout = 0` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-038 | tx | `SET session_replication_role = replica` | refuse statement_class | R 42501, S ok(0), Ss ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| tx-039 | tx | `SET constraint_exclusion = on` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-040 | tx | `DISCARD ALL` | refuse statement_class | R 25001, S 25001, Ss 25001, R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-041 | tx | `DISCARD TEMP` | refuse statement_class | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| tx-042 | tx | `ALTER SYSTEM SET statement_timeout = 0` | refuse statement_class | R 25001, S 25001, Ss 25001, R0 42501 | NOT_READ_ONLY | guard | no | ok |
| tx-043 | tx | `ALTER ROLE exponetdb_reader SET default_transaction_read_only = off` | refuse statement_class | R 25006, S 25006, Ss 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| tx-044 | tx | `ALTER ROLE exponetdb_reader SUPERUSER` | refuse statement_class | R 25006, S 25006, Ss 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| tx-045 | tx | `ALTER DATABASE postgres SET default_transaction_read_only = off` | refuse statement_class | R 25006, S 25006, Ss 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| tx-046 | tx | `SHOW transaction_read_only` | admit | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | rows 1 | nothing (ran) | no | ok |
| tx-047 | tx | `SHOW default_transaction_read_only` | admit | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | rows 1 | nothing (ran) | no | ok |
| tx-048 | tx | `SHOW search_path` | admit | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | rows 1 | nothing (ran) | no | ok |
| tx-049 | tx | `SHOW ALL` | admit | R ok(0), S ok(0), Ss ok(0), R0 ok(0) | 16:rows 347 17:rows 363 18:rows 380 | nothing (ran) | no | ok |
| tx-050 | tx | `SELECT current_setting('transaction_read_only')` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| tx-051 | tx | `SELECT current_setting('search_path')` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-001 | multi | `SELECT 1; SELECT 2` | refuse multiple_statements | R 42601, S 42601, Ss ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-002 | multi | `SELECT 1; DROP TABLE public.accounts` | refuse multiple_statements | R 42601, S 42601, Ss 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-003 | multi | `SELECT 1;; DROP TABLE public.accounts` | refuse multiple_statements | R 42601, S 42601, Ss 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-004 | multi | `;SELECT 1` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-005 | multi | `SELECT 1;` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-006 | multi | `SELECT 1 ; ` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-007 | multi | `SELECT 1\u000a;\u000aDELETE FROM public.accounts` | refuse multiple_statements | R 42601, S 42601, Ss 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-008 | multi | `SELECT 1 /* ; DROP TABLE public.accounts */` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-009 | multi | `SELECT 1 /* x */ ; /* y */ DELETE FROM public.accounts` | refuse multiple_statements | R 42601, S 42601, Ss 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-010 | multi | `SELECT 1 /* /* nested ; */ ; */ ; DELETE FROM public.accounts` | refuse multiple_statements | R 42601, S 42601, Ss 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-011 | multi | `SELECT 1 -- ; DROP TABLE public.accounts` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-012 | multi | `SELECT ';'` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-013 | multi | `SELECT '; DROP TABLE public.accounts'` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-014 | multi | `SELECT E'\'; DROP TABLE public.accounts; --'` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-015 | multi | `SELECT E'\'; DELETE FROM public.accounts; --'; DELETE FROM public.a...` | refuse multiple_statements | R 42601, S 42601, Ss 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-016 | multi | `SELECT 'a'';b'` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-017 | multi | `SELECT $$;$$` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-018 | multi | `SELECT $a$ ; DROP TABLE public.accounts; $a$` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-019 | multi | `SELECT $a$ ; $b$ ; DROP TABLE public.accounts ; $b$ ; $a$` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-020 | multi | `SELECT $$x$$; DELETE FROM public.accounts` | refuse multiple_statements | R 42601, S 42601, Ss 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-021 | multi | `SELECT 1 AS "a;b"` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-022 | multi | `SELECT 1 AS "a"";b"` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-023 | multi | `SELECT 1 AS U&"\003B"` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-024 | multi | `SELECT U&'\003B DROP TABLE public.accounts'` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-025 | multi | `SELECT 1 UESCAPE '!'` | refuse syntax | R 42601, S 42601, Ss 42601, R0 42601 | PARSE_ERROR | guard | no | ok |
| multi-026 | multi | `SELECT U&'!003B' UESCAPE '!'` | admit | R ok(1), S ok(1), Ss ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| multi-027 | multi | `SELECT 1 \g DELETE FROM public.accounts` | refuse syntax | R 42601, S 42601, Ss 42601, R0 42601 | PARSE_ERROR | guard | no | ok |
| multi-028 | multi | `SELECT 1\; DELETE FROM public.accounts` | refuse syntax | R 42601, S 42601, Ss 42601, R0 42601 | PARSE_ERROR | guard | no | ok |
| multi-029 | multi | `SELECT 1 \gexec` | refuse syntax | R 42601, S 42601, Ss 42601, R0 42601 | PARSE_ERROR | guard | no | ok |
| multi-030 | multi | `SELECT 1 UNION ALL SELECT 2; DELETE FROM public.accounts` | refuse multiple_statements | R 42601, S 42601, Ss 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-031 | multi | `SELECT 1; SELECT pg_sleep(1000000)` | refuse multiple_statements | R 42601, S 42601, Ss 57014, R0 57014 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-032 | multi | `EXPLAIN SELECT 1; DELETE FROM public.accounts` | refuse multiple_statements | R 42601, S 42601, Ss 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-033 | multi | `WITH a AS (SELECT 1) SELECT * FROM a; DELETE FROM public.accounts` | refuse multiple_statements | R 42601, S 42601, Ss 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-034 | multi | `VALUES (1); VALUES (2)` | refuse multiple_statements | R 42601, S 42601, Ss ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-035 | multi | `SELECT 1\u0000; DELETE FROM public.accounts` | refuse nul | R 08P01, S 08P01, Ss 08P01, R0 08P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| multi-036 | multi | `SELECT 1 /*\u0000*/` | refuse nul | R 08P01, S 08P01, Ss 08P01, R0 08P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| enc-001 | enc | `SELECT 1\u0000` | refuse nul | R 08P01, S 08P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| enc-002 | enc | `\u0000SELECT 1` | refuse nul | R 08P01, S 08P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| enc-003 | enc | `SELECT 'a\u0000b'` | refuse nul | R 08P01, S 08P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| enc-004 | enc | `SELECT E'\x00'` | refuse syntax | R 22021, S 22021 | PARSE_ERROR | guard | no | ok |
| enc-005 | enc | `SELECT E'\u0000'` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| enc-006 | enc | `SELECT U&'\0000'` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| enc-007 | enc | `SELECT chr(0)` | admit | R 54000, S 54000 | QUERY_FAILED 54000 | server 54000 | no | ok |
| enc-008 | enc | `SELECT convert_from('\xff'::bytea, 'UTF8')` | admit | R 22021, S 22021 | QUERY_FAILED 22021 | server 22021 | no | ok |
| enc-009 | enc | `SELECT convert_from(decode('ff', 'hex'), 'UTF8')` | admit | R 22021, S 22021 | QUERY_FAILED 22021 | server 22021 | no | ok |
| enc-010 | enc | `SELECT �` | admit | R 42703, S 42703 | QUERY_FAILED 42703 | server 42703 | no | ok |
| enc-011 | enc | `SELECT "�"` | admit | R 42703, S 42703 | QUERY_FAILED 42703 | server 42703 | no | ok |
| enc-012 | enc | `\ufeffSELECT 1` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| enc-013 | enc | `ＳＥＬＥＣＴ 1` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| enc-014 | enc | `ЅELECT 1` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| enc-015 | enc | `SELECT 1` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| enc-016 | enc | `SELECT 1` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| enc-017 | enc | `SELECT\u200b1` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| enc-018 | enc | `SE\u200bLECT 1` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| enc-019 | enc | `SELECT\u000b1` | 16:refuse syntax 17:admit 18:admit | 16:R 42601, S 42601 17:R ok(1), S ok(1) 18:R ok(1), S ok(1) | 16:PARSE_ERROR 17:rows 1 18:rows 1 | 16:guard 17:nothing (ran) 18:nothing (ran) | no | 16:over-refused 17:ok 18:ok |
| enc-020 | enc | `SELECT\u000c1` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| enc-021 | enc | `SELECT\u000d\u000a1` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| enc-022 | enc | `SELECT 1 AS "ＤＥＬＥＴＥ"` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| enc-023 | enc | `DELETE FROM public.accounts` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| enc-024 | enc | `ＤＥＬＥＴＥ FROM public.accounts` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| enc-025 | enc | `SELECT 1 AS \u202e` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| enc-026 | enc | `SELECT '\u202e; DELETE FROM public.accounts'` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| enc-027 | enc | `select 1 as "😀"` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| enc-028 | enc | `SELECT 1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,...` | admit | R 54011, S 54011 | QUERY_FAILED 54011 | server 54011 | no | ok |
| enc-029 | enc | `SELECT ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((...` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| enc-030 | enc | `SELECT <x repeated 2000000 times>` | refuse too_large | R 42703, S 42703 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| enc-031 | enc | `` | refuse syntax | R ok(0), S ok(0) | PARSE_ERROR | guard | no | ok |
| enc-032 | enc | `   ` | 16:refuse syntax 17:refuse syntax 18:refuse empty | R ok(0), S ok(0) | PARSE_ERROR | guard | no | ok |
| enc-033 | enc | `-- only a comment` | refuse empty | R ok(0), S ok(0) | PARSE_ERROR | guard | no | ok |
| enc-034 | enc | `/* only a comment */` | refuse empty | R ok(0), S ok(0) | PARSE_ERROR | guard | no | ok |
| enc-035 | enc | `SELECT '�'` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| enc-036 | enc | `SELECT E'\ud800'` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| copy-001 | copy | `COPY (SELECT 1) TO PROGRAM 'touch /tmp/d2-marker-copy-program'` | refuse statement_class | R 42501, S ok(1), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| copy-002 | copy | `COPY public.accounts TO PROGRAM 'touch /tmp/d2-marker-copy-table'` | refuse statement_class | R 42501, S ok(5), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| copy-003 | copy | `COPY public.accounts FROM PROGRAM 'echo 1'` | refuse statement_class | R 42501, S 25006, R0 42501 | NOT_READ_ONLY | guard | no | ok |
| copy-004 | copy | `COPY public.accounts TO '/tmp/d2-marker-copy-file'` | refuse statement_class | R 42501, S ok(5), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| copy-005 | copy | `COPY (SELECT 1) TO '/tmp/d2-marker-copy-file2'` | refuse statement_class | R 42501, S ok(1), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| copy-006 | copy | `COPY public.accounts FROM '/etc/passwd'` | refuse statement_class | R 42501, S 25006, R0 42501 | NOT_READ_ONLY | guard | no | ok |
| copy-007 | copy | `COPY public.accounts TO STDOUT` | refuse statement_class | R ok(5), S ok(5), R0 ok(5) | NOT_READ_ONLY | guard | no | ok |
| copy-008 | copy | `COPY (SELECT * FROM public.accounts) TO STDOUT` | refuse statement_class | R ok(5), S ok(5), R0 ok(5) | NOT_READ_ONLY | guard | no | ok |
| copy-009 | copy | `COPY public.accounts FROM STDIN` | refuse statement_class | R 42501, S 25006, R0 42501 | NOT_READ_ONLY | guard | no | ok |
| copy-010 | copy | `COPY (SELECT 1) TO PROGRAM 'touch /tmp/d2-marker-in-cte'; SELECT 1` | refuse multiple_statements | R 42601, S 42601, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| copy-011 | copy | `WITH x AS (SELECT 1) COPY (SELECT 1) TO PROGRAM 'true'` | refuse syntax | R 42601, S 42601, R0 42601 | PARSE_ERROR | guard | no | ok |
| file-001 | file | `SELECT pg_read_file('/etc/passwd')` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-002 | file | `SELECT pg_read_file('postgresql.conf')` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-003 | file | `SELECT pg_catalog.pg_read_file('/etc/passwd')` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-004 | file | `SELECT pg_read_binary_file('/etc/passwd')` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-005 | file | `SELECT pg_ls_dir('.')` | refuse function | R 42501, S ok(24), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-006 | file | `SELECT pg_ls_dir('/')` | refuse function | R 42501, S ok(22), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-007 | file | `SELECT * FROM pg_ls_logdir()` | refuse function | R 42501, S 58P01, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-008 | file | `SELECT * FROM pg_ls_waldir()` | refuse function | 16:R 42501, S ok(3), R0 42501 17:R 42501, S ok(4), R0 42501 18:R 42501, S ok(3), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-009 | file | `SELECT * FROM pg_ls_tmpdir()` | refuse function | R 42501, S ok(0), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-010 | file | `SELECT * FROM pg_ls_archive_statusdir()` | refuse function | R 42501, S ok(0), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-011 | file | `SELECT pg_stat_file('postgresql.conf')` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-012 | file | `SELECT lo_import('/etc/passwd')` | refuse function | R 42501, S 25006, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-013 | file | `SELECT lo_import('/etc/passwd', 424242)` | refuse function | R 42501, S 25006, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-014 | file | `SELECT lo_export(1, '/tmp/d2-marker-lo-export')` | refuse function | R 42501, S 42704, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-015 | file | `SELECT lo_create(0)` | refuse function | R 25006, S 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-016 | file | `SELECT lo_create(424243)` | refuse function | R 25006, S 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-017 | file | `SELECT lo_unlink(424243)` | refuse function | R 25006, S 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-018 | file | `SELECT lo_get(424243)` | refuse function | R 42704, S 42704, R0 42704 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-019 | file | `SELECT lo_from_bytea(0, 'x'::bytea)` | refuse function | R 25006, S 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-020 | file | `SELECT lo_put(424243, 0, 'x'::bytea)` | refuse function | R 25006, S 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-021 | file | `SELECT loread(0, 1)` | refuse function | R 42704, S 42704, R0 42704 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-022 | file | `SELECT lo_open(424243, 131072)` | refuse function | R 25006, S 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-023 | file | `SELECT data FROM pg_catalog.pg_largeobject` | admit | R ok(0), S ok(0), R0 ok(0) | rows 0 | nothing (ran) | no | ok |
| file-024 | file | `SELECT oid FROM pg_catalog.pg_largeobject_metadata` | admit | R ok(0), S ok(0), R0 ok(0) | rows 0 | nothing (ran) | no | ok |
| file-025 | file | `SELECT * FROM public.ft_passwd` | admit | R ok(19), S ok(19), R0 ok(19) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-026 | file | `SELECT * FROM public.ft_loop` | admit | R 42704, S 42704, R0 42704 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-027 | file | `SELECT * FROM public.ft_loop LIMIT 1` | admit | R 42704, S 42704, R0 42704 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-028 | file | `SELECT dblink_connect('host=127.0.0.1 dbname=postgres')` | refuse function | R 42883, S 42883, R0 42883 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-029 | file | `SELECT dblink_exec('host=127.0.0.1 dbname=postgres', 'DROP TABLE pu...` | refuse function | R 42883, S 42883, R0 42883 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-030 | file | `SELECT * FROM dblink('host=127.0.0.1 dbname=postgres', 'SELECT 1') ...` | refuse function | R 42883, S 42883, R0 42883 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-031 | file | `SELECT public.dblink_exec('host=/var/run/postgresql dbname=postgres...` | refuse function | R 2F003, S 2F003, R0 2F003 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-032 | file | `SELECT dblink_send_query('c', 'SELECT 1')` | refuse function | R 42883, S 42883, R0 42883 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-033 | file | `SELECT postgres_fdw_handler()` | refuse function | R 42883, S 42883, R0 42883 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-034 | file | `SELECT file_fdw_handler()` | refuse function | R 42883, S 42883, R0 42883 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-035 | file | `SELECT pg_logical_emit_message(true, 'd2', 'x')` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-036 | file | `SELECT pg_create_restore_point('d2')` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-037 | file | `SELECT pg_switch_wal()` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-038 | file | `SELECT pg_backup_start('d2')` | refuse function | R 42501, S 57014, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-039 | file | `SELECT pg_start_backup('d2')` | refuse function | R 42883, S 42883, R0 42883 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-040 | file | `SELECT pg_current_logfile()` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-041 | file | `SELECT pg_rotate_logfile()` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-042 | file | `SELECT pg_reload_conf()` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-043 | file | `SELECT pg_promote()` | refuse function | R 42501, S 55000, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-044 | file | `SELECT pg_wal_replay_pause()` | refuse function | R 42501, S 55000, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-045 | file | `SELECT pg_stat_reset()` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-046 | file | `SELECT pg_stat_reset_shared('bgwriter')` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-047 | file | `SELECT pg_stat_statements_reset()` | refuse function | R 42883, S 42883, R0 42883 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-048 | file | `SELECT pg_replication_slot_advance('x', '0/0')` | refuse function | 16:R 42501, S XX000, R0 42501 17:R 42501, S XX000, R0 42501 18:R 42501, S 22023, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-049 | file | `SELECT pg_create_logical_replication_slot('d2', 'test_decoding')` | refuse function | R 42501, S 55000, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-050 | file | `SELECT pg_import_system_collations('public')` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-051 | file | `SELECT pg_export_snapshot()` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-052 | file | `SELECT pg_get_wal_replay_pause_state()` | refuse function | R 55000, S 55000, R0 55000 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| file-053 | file | `SELECT * FROM pg_catalog.pg_read_all_data` | admit | R 42P01, S 42P01, R0 42P01 | QUERY_FAILED 42P01 | server 42P01 | no | ok |
| write-001 | write | `INSERT INTO public.accounts VALUES (99, 'x', 'x')` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-002 | write | `INSERT INTO public.accounts VALUES (99, 'x', 'x') RETURNING *` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-003 | write | `UPDATE public.accounts SET note = 'x'` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-004 | write | `DELETE FROM public.accounts` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-005 | write | `DELETE FROM public.accounts RETURNING *` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-006 | write | `TRUNCATE public.accounts` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-007 | write | `MERGE INTO public.accounts a USING (VALUES (1)) v(id) ON a.id = v.i...` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-008 | write | `WITH x AS (DELETE FROM public.accounts RETURNING *) SELECT * FROM x` | refuse data_modifying | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-009 | write | `WITH x AS (INSERT INTO public.accounts VALUES (98, 'x', 'x') RETURN...` | refuse data_modifying | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-010 | write | `WITH x AS (UPDATE public.accounts SET note = 'x' RETURNING *) SELEC...` | refuse data_modifying | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-011 | write | `WITH x AS (DELETE FROM public.accounts RETURNING *) SELECT 1` | refuse data_modifying | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-012 | write | `WITH x AS (DELETE FROM public.accounts) SELECT 1` | refuse data_modifying | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-013 | write | `SELECT 1 WHERE EXISTS (WITH x AS (DELETE FROM public.accounts RETUR...` | refuse data_modifying | R 0A000, S 0A000, R0 0A000 | NOT_READ_ONLY | guard | no | ok |
| write-014 | write | `SELECT (WITH x AS (DELETE FROM public.accounts RETURNING 1) SELECT ...` | refuse data_modifying | R 0A000, S 0A000, R0 0A000 | NOT_READ_ONLY | guard | no | ok |
| write-015 | write | `SELECT * FROM (WITH x AS (DELETE FROM public.accounts RETURNING 1) ...` | refuse data_modifying | R 0A000, S 0A000, R0 0A000 | NOT_READ_ONLY | guard | no | ok |
| write-016 | write | `WITH RECURSIVE x AS (SELECT 1 UNION ALL SELECT 1 FROM x WHERE false...` | refuse data_modifying | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-017 | write | `WITH x AS (MERGE INTO public.accounts a USING (VALUES (1)) v(id) ON...` | 16:refuse syntax 17:refuse data_modifying 18:refuse data_modifying | 16:R 42601, S 42601, R0 42601 17:R 25006, S 25006, R0 25006 18:R 25006, S 25006, R0 25006 | 16:PARSE_ERROR 17:NOT_READ_ONLY 18:NOT_READ_ONLY | guard | no | ok |
| write-018 | write | `SELECT * INTO public.d2_copy FROM public.accounts` | refuse select_into | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-019 | write | `SELECT * INTO TEMP d2_temp FROM public.accounts` | refuse select_into | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-020 | write | `SELECT * INTO UNLOGGED public.d2_unlogged FROM public.accounts` | refuse select_into | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-021 | write | `CREATE TABLE public.d2_ctas AS SELECT * FROM public.accounts` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-022 | write | `CREATE TEMP TABLE d2_ctas_temp AS SELECT 1` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-023 | write | `CREATE MATERIALIZED VIEW public.d2_mv AS SELECT 1` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-024 | write | `CREATE TABLE public.d2_t (a int)` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-025 | write | `CREATE TEMP TABLE d2_t (a int)` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-026 | write | `CREATE SEQUENCE public.d2_seq` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-027 | write | `CREATE FUNCTION public.d2_f() RETURNS int LANGUAGE sql AS 'SELECT 1'` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-028 | write | `CREATE OR REPLACE FUNCTION public.writer() RETURNS int LANGUAGE sql...` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-029 | write | `CREATE EXTENSION dblink` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-030 | write | `CREATE SCHEMA d2` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-031 | write | `CREATE ROLE d2_role` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-032 | write | `CREATE ROLE d2_role SUPERUSER` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-033 | write | `ALTER TABLE public.accounts ADD COLUMN d2 int` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-034 | write | `ALTER TABLE public.accounts DISABLE ROW LEVEL SECURITY` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-035 | write | `DROP TABLE public.accounts` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-036 | write | `DROP SCHEMA public CASCADE` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-037 | write | `DROP ROLE exponetdb_reader` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-038 | write | `DROP DATABASE postgres` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-039 | write | `COMMENT ON TABLE public.accounts IS 'x'` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-040 | write | `SECURITY LABEL ON TABLE public.accounts IS 'x'` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-041 | write | `GRANT ALL ON public.accounts TO PUBLIC` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-042 | write | `GRANT pg_write_all_data TO exponetdb_reader` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-043 | write | `GRANT pg_execute_server_program TO exponetdb_reader` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-044 | write | `REVOKE ALL ON public.accounts FROM exponetdb_reader` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-045 | write | `REASSIGN OWNED BY postgres TO exponetdb_reader` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-046 | write | `ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-047 | write | `REFRESH MATERIALIZED VIEW public.mv_accounts` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-048 | write | `VACUUM public.accounts` | refuse statement_class | R 25001, S 25001, R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| write-049 | write | `ANALYZE public.accounts` | refuse statement_class | R ok(0), S ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| write-050 | write | `REINDEX TABLE public.accounts` | refuse statement_class | R 42501, S ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| write-051 | write | `CLUSTER public.accounts USING accounts_pkey` | refuse statement_class | R 42501, S ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| write-052 | write | `CHECKPOINT` | refuse statement_class | R 42501, S ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| write-053 | write | `LOAD 'auto_explain'` | refuse statement_class | R 42501, S ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| write-054 | write | `IMPORT FOREIGN SCHEMA public FROM SERVER fs INTO public` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| write-055 | write | `SELECT * FROM public.accounts a WHERE a.id = 1 RETURNING 1` | refuse syntax | R 42601, S 42601, R0 42601 | PARSE_ERROR | guard | no | ok |
| proc-001 | proc | `DO $$ BEGIN DELETE FROM public.accounts; END $$` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| proc-002 | proc | `DO $$ BEGIN PERFORM pg_sleep(1000000); END $$` | refuse statement_class | R 57014, S 57014, R0 57014 | NOT_READ_ONLY | guard | no | ok |
| proc-003 | proc | `DO LANGUAGE plpgsql $x$ BEGIN RAISE NOTICE 'x'; END $x$` | refuse statement_class | R ok(0), S ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| proc-004 | proc | `CALL public.d2_proc()` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| proc-005 | proc | `CALL pg_catalog.pg_stat_reset()` | refuse statement_class | R 42809, S 42809, R0 42809 | NOT_READ_ONLY | guard | no | ok |
| proc-006 | proc | `PREPARE d2p AS SELECT 1` | refuse statement_class | R ok(0), S ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| proc-007 | proc | `PREPARE d2p AS DELETE FROM public.accounts` | refuse statement_class | R ok(0), S ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| proc-008 | proc | `EXECUTE d2p` | refuse statement_class | R 26000, S 26000, R0 26000 | NOT_READ_ONLY | guard | no | ok |
| proc-009 | proc | `EXECUTE d2p(1)` | refuse statement_class | R 26000, S 26000, R0 26000 | NOT_READ_ONLY | guard | no | ok |
| proc-010 | proc | `DEALLOCATE d2p` | refuse statement_class | R 26000, S 26000, R0 26000 | NOT_READ_ONLY | guard | no | ok |
| proc-011 | proc | `DEALLOCATE ALL` | refuse statement_class | R ok(0), S ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| proc-012 | proc | `DECLARE d2c CURSOR FOR SELECT 1` | refuse statement_class | R ok(0), S ok(0), R0 25P01 | NOT_READ_ONLY | guard | no | ok |
| proc-013 | proc | `DECLARE d2c CURSOR WITH HOLD FOR SELECT * FROM public.accounts` | refuse statement_class | R ok(0), S ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| proc-014 | proc | `DECLARE d2c NO SCROLL CURSOR FOR WITH x AS (DELETE FROM public.acco...` | refuse statement_class | R 0A000, S 0A000, R0 0A000 | NOT_READ_ONLY | guard | no | ok |
| proc-015 | proc | `FETCH ALL FROM d2c` | refuse statement_class | R 34000, S 34000, R0 34000 | NOT_READ_ONLY | guard | no | ok |
| proc-016 | proc | `FETCH FORWARD 10 FROM d2c` | refuse statement_class | R 34000, S 34000, R0 34000 | NOT_READ_ONLY | guard | no | ok |
| proc-017 | proc | `MOVE FORWARD 1 FROM d2c` | refuse statement_class | R 34000, S 34000, R0 34000 | NOT_READ_ONLY | guard | no | ok |
| proc-018 | proc | `CLOSE d2c` | refuse statement_class | R 34000, S 34000, R0 34000 | NOT_READ_ONLY | guard | no | ok |
| proc-019 | proc | `CLOSE ALL` | refuse statement_class | R ok(0), S ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| proc-020 | proc | `LISTEN d2` | refuse statement_class | R ok(0), S ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| proc-021 | proc | `UNLISTEN *` | refuse statement_class | R ok(0), S ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| proc-022 | proc | `NOTIFY d2, 'x'` | refuse statement_class | R ok(0), S ok(0), R0 ok(0) | NOT_READ_ONLY | guard | no | ok |
| proc-023 | proc | `LOCK TABLE public.accounts` | refuse statement_class | R 42501, S ok(0), R0 25P01 | NOT_READ_ONLY | guard | no | ok |
| proc-024 | proc | `LOCK TABLE public.accounts IN ACCESS EXCLUSIVE MODE` | refuse statement_class | R 42501, S ok(0), R0 25P01 | NOT_READ_ONLY | guard | no | ok |
| proc-025 | proc | `LOCK TABLE public.accounts IN ACCESS SHARE MODE NOWAIT` | refuse statement_class | R ok(0), S ok(0), R0 25P01 | NOT_READ_ONLY | guard | no | ok |
| proc-026 | proc | `EXPLAIN (ANALYZE) DELETE FROM public.accounts` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| proc-027 | proc | `EXPLAIN ANALYZE DELETE FROM public.accounts` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| proc-028 | proc | `EXPLAIN (ANALYZE true) INSERT INTO public.accounts VALUES (97, 'x',...` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| proc-029 | proc | `EXPLAIN (ANALYZE) UPDATE public.accounts SET note = 'x'` | refuse statement_class | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| proc-030 | proc | `EXPLAIN (ANALYZE) TRUNCATE public.accounts` | refuse syntax | R 42601, S 42601, R0 42601 | PARSE_ERROR | guard | no | ok |
| proc-031 | proc | `EXPLAIN (ANALYZE) CREATE TABLE public.d2_exp AS SELECT 1` | refuse statement_class | R 42501, S ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| proc-032 | proc | `EXPLAIN (ANALYZE) SELECT * INTO public.d2_exp2 FROM public.accounts` | refuse select_into | R 42501, S ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| proc-033 | proc | `EXPLAIN (ANALYZE) WITH x AS (DELETE FROM public.accounts RETURNING ...` | refuse data_modifying | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| proc-034 | proc | `EXPLAIN (ANALYZE) EXECUTE d2p` | refuse statement_class | R 26000, S 26000, R0 26000 | NOT_READ_ONLY | guard | no | ok |
| proc-035 | proc | `EXPLAIN (ANALYZE) SELECT nextval('public.s')` | refuse function | R 42501, S 25006, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| proc-036 | proc | `EXPLAIN (ANALYZE) SELECT pg_sleep(0.1)` | refuse function | R ok(0), S ok(0), R0 ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| proc-037 | proc | `EXPLAIN (ANALYZE) SELECT public.writer()` | refuse function | R 25006, S 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| proc-038 | proc | `EXPLAIN (ANALYZE) SELECT 1` | admit | R ok(0), S ok(0), R0 ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| proc-039 | proc | `EXPLAIN SELECT 1` | admit | R ok(0), S ok(0), R0 ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| proc-040 | proc | `EXPLAIN (FORMAT JSON) SELECT 1` | admit | R ok(0), S ok(0), R0 ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| proc-041 | proc | `EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM public.accounts` | admit | R ok(0), S ok(0), R0 ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| proc-042 | proc | `EXPLAIN (ANALYZE false) DELETE FROM public.accounts` | refuse statement_class | R 42501, S ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| proc-043 | proc | `EXPLAIN (ANALYZE off) INSERT INTO public.accounts VALUES (1, 'x', 'x')` | refuse statement_class | R 42501, S ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| func-001 | func | `SELECT nextval('public.s')` | refuse function | R 42501, S 25006, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-002 | func | `SELECT pg_catalog.nextval('public.s')` | refuse function | R 42501, S 25006, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-003 | func | `SELECT setval('public.s', 100)` | refuse function | R 42501, S 25006, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-004 | func | `SELECT currval('public.s')` | refuse function | R 55000, S 55000, R0 55000 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-005 | func | `SELECT lastval()` | refuse function | R 55000, S 55000, R0 55000 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-006 | func | `SELECT pg_advisory_lock(1)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-007 | func | `SELECT pg_advisory_lock(1, 2)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-008 | func | `SELECT pg_advisory_lock_shared(1)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-009 | func | `SELECT pg_advisory_xact_lock(1)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-010 | func | `SELECT pg_advisory_xact_lock_shared(1)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-011 | func | `SELECT pg_try_advisory_lock(1)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-012 | func | `SELECT pg_try_advisory_xact_lock(1)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-013 | func | `SELECT pg_advisory_unlock_all()` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-014 | func | `SELECT pg_sleep(1000000)` | refuse function | R 57014, S 57014, R0 57014 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-015 | func | `SELECT pg_sleep(0)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-016 | func | `SELECT pg_sleep_for('1 day')` | refuse function | R 57014, S 57014, R0 57014 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-017 | func | `SELECT pg_sleep_until('infinity')` | refuse function | R 57014, S 57014, R0 57014 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-018 | func | `SELECT pg_catalog.pg_sleep(1e6)` | refuse function | R 57014, S 57014, R0 57014 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-019 | func | `SELECT (0.5::float8).pg_sleep` | refuse field_selection | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-020 | func | `SELECT (1).pg_sleep` | refuse field_selection | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-021 | func | `SELECT pg_terminate_backend(pg_backend_pid())` | refuse function | R 57P01, S 57P01, R0 57P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-022 | func | `SELECT pg_terminate_backend(1)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-023 | func | `SELECT pg_cancel_backend(1)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-024 | func | `SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity` | refuse function | 16:R 42501, S 57P01, R0 42501 17:R 42501, S 57P01, R0 42501 18:R 42501, S 57P01, R0 57P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-025 | func | `SELECT set_config('transaction_read_only', 'off', false)` | refuse function | R 25001, S 25001, R0 25001 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-026 | func | `SELECT set_config('transaction_read_only', 'off', true)` | refuse function | R 25001, S 25001, R0 25001 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-027 | func | `SELECT set_config('statement_timeout', '0', true)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-028 | func | `SELECT pg_catalog.set_config('search_path', 'public', true)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-029 | func | `SELECT set_config('role', 'postgres', true)` | refuse function | R 42501, S ok(1), R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-030 | func | `SELECT pg_notify('d2', 'x')` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-031 | func | `SELECT txid_current()` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-032 | func | `SELECT txid_current_if_assigned()` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-033 | func | `SELECT pg_current_xact_id()` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-034 | func | `SELECT pg_current_xact_id_if_assigned()` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-035 | func | `SELECT pg_xact_status('1'::xid8)` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-036 | func | `SELECT public.writer()` | refuse function | R 25006, S 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-037 | func | `SELECT * FROM public.writer()` | refuse function | R 25006, S 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-038 | func | `SELECT public.writer() FROM public.accounts` | refuse function | R 25006, S 25006, R0 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-039 | func | `SELECT writer()` | refuse function | R 42883, S 42883, R0 42883 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-040 | func | `SELECT query_to_xml('DELETE FROM public.accounts RETURNING 1', true...` | refuse function | R 0A000, S 0A000, R0 0A000 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-041 | func | `SELECT query_to_xml('SELECT 1', true, true, '')` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-042 | func | `SELECT query_to_xmlschema('SELECT 1', true, true, '')` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-043 | func | `SELECT cursor_to_xml('c', 1, true, true, '')` | refuse function | R 34000, S 34000, R0 34000 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-044 | func | `SELECT table_to_xml('public.accounts', true, true, '')` | refuse function | R ok(1), S ok(1), R0 ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-045 | func | `SELECT schema_to_xml('public', true, true, '')` | refuse function | R 42501, S 25006, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-046 | func | `SELECT database_to_xml(true, true, '')` | refuse function | R 42501, S 25006, R0 42501 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-047 | func | `SELECT * FROM ts_stat('SELECT to_tsvector(note) FROM public.accounts')` | refuse function | R ok(5), S ok(5), R0 ok(5) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-048 | func | `SELECT (ROW(1)).ts_stat` | refuse field_selection | R 42703, S 42703, R0 42703 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| func-049 | func | `SELECT q.ts_stat FROM (SELECT 'SELECT 1'::text) q(a)` | admit | R 42703, S 42703, R0 42703 | QUERY_FAILED 42703 | server 42703 | no | ok |
| func-050 | func | `SELECT t.pg_sleep FROM (SELECT 0.5::float8) t` | admit | R 42703, S 42703, R0 42703 | QUERY_FAILED 42703 | server 42703 | no | ok |
| func-051 | func | `SELECT a.pg_sleep FROM public.accounts a` | admit | R 42703, S 42703, R0 42703 | QUERY_FAILED 42703 | server 42703 | no | ok |
| func-052 | func | `SELECT pg_catalog.pg_get_expr('x', 0)` | admit | R 0A000, S 0A000, R0 0A000 | QUERY_FAILED 0A000 | server 0A000 | no | ok |
| func-053 | func | `SELECT pg_get_functiondef('public.writer()'::regprocedure)` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-054 | func | `SELECT pg_advisory_lock FROM (SELECT 1) pg_advisory_lock` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-055 | func | `SELECT 1 AS pg_sleep` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-056 | func | `SELECT now()` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-057 | func | `SELECT clock_timestamp()` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-058 | func | `SELECT random()` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-059 | func | `SELECT gen_random_uuid()` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-060 | func | `SELECT version()` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-061 | func | `SELECT pg_backend_pid()` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-062 | func | `SELECT inet_server_addr(), inet_server_port()` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-063 | func | `SELECT current_setting('server_version')` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-064 | func | `SELECT current_setting('data_directory')` | admit | R 42501, S ok(1), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-065 | func | `SELECT current_setting('config_file')` | admit | R 42501, S ok(1), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-066 | func | `SELECT current_setting('hba_file')` | admit | R 42501, S ok(1), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-067 | func | `SELECT current_setting('log_directory')` | admit | R 42501, S ok(1), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-068 | func | `SELECT current_setting('unix_socket_directories')` | admit | R 42501, S ok(1), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-069 | func | `SELECT current_setting('ssl_key_file')` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-070 | func | `SELECT current_setting('archive_command')` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-071 | func | `SELECT current_setting('primary_conninfo', true)` | admit | R 42501, S ok(1), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-072 | func | `SELECT current_setting('shared_preload_libraries')` | admit | R 42501, S ok(1), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-073 | func | `SELECT name, setting, source, sourcefile FROM pg_catalog.pg_settings` | admit | 16:R ok(347), S ok(369), R0 ok(347) 17:R ok(363), S ok(385), R0 ok(363) 18:R ok(380), S ok(404), R0 ok(380) | 16:rows 347 17:rows 363 18:rows 380 | nothing (ran) | no | ok |
| func-074 | func | `SELECT * FROM pg_catalog.pg_file_settings` | admit | 16:R 42501, S ok(14), R0 42501 17:R 42501, S ok(14), R0 42501 18:R 42501, S ok(15), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-075 | func | `SELECT * FROM pg_catalog.pg_hba_file_rules` | admit | R 42501, S ok(3), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-076 | func | `SELECT * FROM pg_catalog.pg_ident_file_mappings` | admit | R 42501, S ok(0), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-077 | func | `SELECT * FROM pg_catalog.pg_config` | admit | R 42501, S ok(23), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-078 | func | `SELECT * FROM pg_catalog.pg_shmem_allocations` | admit | 16:R 42501, S ok(61), R0 42501 17:R 42501, S ok(67), R0 42501 18:R 42501, S ok(77), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-079 | func | `SELECT * FROM pg_catalog.pg_backend_memory_contexts` | admit | 16:R 42501, S ok(118), R0 42501 17:R 42501, S ok(119), R0 42501 18:R 42501, S ok(122), R0 42501 | QUERY_FAILED 42501 | server role | no | ok |
| func-080 | func | `SELECT * FROM pg_catalog.pg_stat_ssl` | admit | 16:R ok(1), S ok(3), R0 ok(1) 17:R ok(1), S ok(4), R0 ok(1) 18:R ok(1), S ok(2), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| func-081 | func | `SELECT * FROM pg_catalog.pg_stat_activity` | admit | 16:R ok(8), S ok(8), R0 ok(8) 17:R ok(9), S ok(9), R0 ok(9) 18:R ok(10), S ok(10), R0 ok(10) | 16:rows 8 17:rows 9 18:rows 10 | nothing (ran) | no | ok |
| func-082 | func | `SELECT * FROM pg_catalog.pg_stat_replication` | admit | R ok(0), S ok(0), R0 ok(0) | rows 0 | nothing (ran) | no | ok |
| func-083 | func | `SELECT * FROM pg_catalog.pg_stat_wal_receiver` | admit | R ok(0), S ok(0), R0 ok(0) | rows 0 | nothing (ran) | no | ok |
| func-084 | func | `SELECT * FROM pg_catalog.pg_replication_slots` | admit | R ok(0), S ok(0), R0 ok(0) | rows 0 | nothing (ran) | no | ok |
| func-085 | func | `SELECT * FROM pg_catalog.pg_foreign_server` | admit | R ok(2), S ok(2), R0 ok(2) | rows 2 | nothing (ran) | no | ok |
| func-086 | func | `SELECT srvname, srvoptions FROM pg_catalog.pg_foreign_server` | admit | R ok(2), S ok(2), R0 ok(2) | rows 2 | nothing (ran) | no | ok |
| func-087 | func | `SELECT * FROM pg_catalog.pg_foreign_data_wrapper` | admit | R ok(3), S ok(3), R0 ok(3) | rows 3 | nothing (ran) | no | ok |
| func-088 | func | `SELECT * FROM pg_catalog.pg_locks` | admit | R ok(2), S ok(2), R0 ok(2) | rows 2 | nothing (ran) | no | ok |
| func-089 | func | `SELECT * FROM pg_catalog.pg_prepared_xacts` | admit | R ok(0), S ok(0), R0 ok(0) | rows 0 | nothing (ran) | no | ok |
| func-090 | func | `SELECT * FROM pg_catalog.pg_roles` | admit | 16:R ok(21), S ok(21), R0 ok(21) 17:R ok(23), S ok(23), R0 ok(23) 18:R ok(23), S ok(23), R0 ok(23) | 16:rows 21 17:rows 23 18:rows 23 | nothing (ran) | no | ok |
| func-091 | func | `SELECT * FROM pg_catalog.pg_auth_members` | admit | 16:R ok(9), S ok(9), R0 ok(9) 17:R ok(10), S ok(10), R0 ok(10) 18:R ok(9), S ok(9), R0 ok(9) | 16:rows 9 17:rows 10 18:rows 9 | nothing (ran) | no | ok |
| func-092 | func | `SELECT * FROM pg_catalog.pg_database` | admit | 16:R ok(11), S ok(11), R0 ok(11) 17:R ok(18), S ok(18), R0 ok(18) 18:R ok(10), S ok(10), R0 ok(10) | 16:rows 11 17:rows 18 18:rows 10 | nothing (ran) | no | ok |
| func-093 | func | `SELECT * FROM pg_catalog.pg_extension` | admit | R ok(4), S ok(4), R0 ok(4) | rows 4 | nothing (ran) | no | ok |
| func-094 | func | `SELECT * FROM pg_catalog.pg_proc WHERE proname = 'writer'` | admit | R ok(1), S ok(1), R0 ok(1) | rows 1 | nothing (ran) | no | ok |
| lock-001 | lock | `SELECT * FROM public.accounts FOR UPDATE` | refuse locking_clause | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| lock-002 | lock | `SELECT * FROM public.accounts FOR NO KEY UPDATE` | refuse locking_clause | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| lock-003 | lock | `SELECT * FROM public.accounts FOR SHARE` | refuse locking_clause | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| lock-004 | lock | `SELECT * FROM public.accounts FOR KEY SHARE` | refuse locking_clause | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| lock-005 | lock | `SELECT * FROM public.accounts FOR UPDATE NOWAIT` | refuse locking_clause | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| lock-006 | lock | `SELECT * FROM public.accounts FOR UPDATE SKIP LOCKED` | refuse locking_clause | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| lock-007 | lock | `SELECT * FROM public.accounts FOR UPDATE OF accounts` | refuse locking_clause | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| lock-008 | lock | `SELECT * FROM (SELECT * FROM public.accounts FOR UPDATE) q` | refuse locking_clause | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| lock-009 | lock | `WITH x AS (SELECT * FROM public.accounts FOR UPDATE) SELECT * FROM x` | refuse locking_clause | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| lock-010 | lock | `SELECT * FROM public.accounts WHERE id IN (SELECT id FROM public.ac...` | refuse locking_clause | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| lock-011 | lock | `(SELECT * FROM public.accounts FOR UPDATE) UNION (SELECT * FROM pub...` | refuse node | R 0A000, S 0A000, R0 0A000 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| lock-012 | lock | `SELECT * FROM public.accounts a JOIN public.accounts b USING (id) F...` | refuse locking_clause | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| lock-013 | lock | `EXPLAIN SELECT * FROM public.accounts FOR UPDATE` | refuse locking_clause | R 42501, S ok(0), R0 42501 | NOT_READ_ONLY | guard | no | ok |
| lock-014 | lock | `SELECT id FROM public.accounts ORDER BY id LIMIT 1 FOR UPDATE` | refuse locking_clause | R 25006, S 25006, R0 25006 | NOT_READ_ONLY | guard | no | ok |
| shadow-001 | shadow | `SELECT lower('X')` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| shadow-002 | shadow | `SELECT pg_catalog.lower('X')` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| shadow-003 | shadow | `SELECT shadow.lower('X')` | refuse function | R 25006, S 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-004 | shadow | `SELECT public.lower('X')` | refuse function | R 25006, S 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-005 | shadow | `SELECT pg_temp.lower('X')` | refuse function | R 3F000, S 3F000 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-006 | shadow | `SELECT 1 + 2` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| shadow-007 | shadow | `SELECT 1 OPERATOR(pg_catalog.+) 2` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| shadow-008 | shadow | `SELECT 1 OPERATOR(public.+) 2` | refuse operator | R 25006, S 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-009 | shadow | `SELECT 1 OPERATOR(shadow.+) 2` | refuse operator | R 25006, S 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-010 | shadow | `SELECT 1 OPERATOR(+) 2` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| shadow-011 | shadow | `SELECT 'a' \|\| 'b'` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| shadow-012 | shadow | `SELECT id FROM public.accounts ORDER BY id USING OPERATOR(public.<)` | refuse operator | R 42883, S 42883 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-013 | shadow | `SELECT 1 = ANY (SELECT 1) AND 1 OPERATOR(public.=) ANY (SELECT 1)` | refuse operator | R 42883, S 42883 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-014 | shadow | `SELECT 'x'::public.d2_type` | refuse cast | R 22P02, S 22P02 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-015 | shadow | `SELECT 'x'::shadow.d2_type` | refuse cast | R 42704, S 42704 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-016 | shadow | `SELECT 1::pg_temp.int4` | refuse cast | R 3F000, S 3F000 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-017 | shadow | `SELECT 1::int4` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| shadow-018 | shadow | `SELECT 1::pg_catalog.int4` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| shadow-019 | shadow | `SELECT CAST('1' AS public.d2_dom)` | refuse cast | R ok(1), S ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-020 | shadow | `SELECT 'x' COLLATE public.d2_collation` | admit | R 42704, S 42704 | QUERY_FAILED 42704 | server 42704 | no | ok |
| shadow-021 | shadow | `SELECT * FROM accounts` | refuse relation_unqualified | R 42P01, S 42P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-022 | shadow | `SELECT * FROM pg_stat_activity` | refuse relation_unqualified | 16:R ok(8), S ok(8) 17:R ok(9), S ok(9) 18:R ok(10), S ok(10) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-023 | shadow | `SELECT * FROM pg_class` | refuse relation_unqualified | 16:R ok(431), S ok(431) 17:R ok(433), S ok(433) 18:R ok(433), S ok(433) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-024 | shadow | `SELECT * FROM public.accounts` | admit | R ok(5), S ok(5) | rows 5 | nothing (ran) | no | ok |
| shadow-025 | shadow | `TABLE public.accounts` | admit | R ok(5), S ok(5) | rows 5 | nothing (ran) | no | ok |
| shadow-026 | shadow | `VALUES (1), (2)` | admit | R ok(2), S ok(2) | rows 2 | nothing (ran) | no | ok |
| shadow-027 | shadow | `SELECT * FROM pg_catalog.pg_stat_activity` | admit | 16:R ok(8), S ok(8) 17:R ok(9), S ok(9) 18:R ok(10), S ok(10) | 16:rows 8 17:rows 9 18:rows 10 | nothing (ran) | no | ok |
| shadow-028 | shadow | `SELECT * FROM public.pg_stat_activity` | admit | R 42P01, S 42P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-029 | shadow | `SELECT * FROM postgres.public.accounts` | refuse relation_unqualified | R 0A000, S 0A000 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-030 | shadow | `SELECT * FROM other_db.public.accounts` | refuse relation_unqualified | R 0A000, S 0A000 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-031 | shadow | `SELECT * FROM pg_temp.accounts` | admit | R 42P01, S 42P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-032 | shadow | `SELECT * FROM pg_temp_1.accounts` | admit | R 42P01, S 42P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-033 | shadow | `SELECT * FROM public.v` | admit | R ok(5), S ok(5) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-034 | shadow | `SELECT * FROM public.v_nextval` | admit | R 42501, S 25006 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-035 | shadow | `SELECT * FROM public.v_advisory` | admit | R ok(1), S ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-036 | shadow | `SELECT * FROM public.v_sleep` | admit | R ok(1), S ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-037 | shadow | `SELECT * FROM public.mv_accounts` | admit | R ok(5), S ok(5) | rows 5 | nothing (ran) | no | ok |
| shadow-038 | shadow | `SELECT * FROM public.s` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| shadow-039 | shadow | `SELECT * FROM public.ft_passwd` | admit | R ok(19), S ok(19) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-040 | shadow | `SELECT * FROM public.part_parent` | admit | R 42704, S 42704 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-041 | shadow | `SELECT * FROM information_schema.tables` | admit | 16:R ok(219), S ok(219) 17:R ok(221), S ok(221) 18:R ok(223), S ok(223) | 16:rows 219 17:rows 221 18:rows 223 | nothing (ran) | no | ok |
| shadow-042 | shadow | `SELECT * FROM information_schema.user_mapping_options` | refuse relation_secret | R ok(0), S ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-043 | shadow | `SELECT * FROM information_schema.user_mappings` | refuse relation_secret | R ok(0), S ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-044 | shadow | `SELECT * FROM information_schema._pg_user_mappings` | refuse relation_secret | R ok(0), S ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-045 | shadow | `SELECT * FROM pg_catalog.pg_authid` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-046 | shadow | `SELECT * FROM pg_authid` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-047 | shadow | `TABLE pg_catalog.pg_authid` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-048 | shadow | `SELECT * FROM pg_catalog.pg_shadow` | refuse relation_secret | R ok(6), S ok(6) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-049 | shadow | `SELECT * FROM pg_catalog.pg_user_mapping` | refuse relation_secret | R ok(0), S ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-050 | shadow | `SELECT * FROM pg_catalog.pg_user_mappings` | refuse relation_secret | R ok(0), S ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-051 | shadow | `SELECT * FROM pg_catalog.pg_subscription` | refuse relation_secret | R ok(0), S ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-052 | shadow | `SELECT * FROM pg_catalog.pg_db_role_setting` | refuse relation_secret | R ok(5), S ok(5) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-053 | shadow | `SELECT * FROM pg_catalog.pg_statistic` | refuse relation_secret | 16:R ok(409), S ok(409) 17:R ok(410), S ok(410) 18:R ok(412), S ok(412) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-054 | shadow | `SELECT * FROM pg_catalog.pg_stats` | refuse relation_secret | 16:R ok(409), S ok(409) 17:R ok(410), S ok(410) 18:R ok(412), S ok(412) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-055 | shadow | `SELECT * FROM pg_catalog."pg_authid"` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-056 | shadow | `SELECT * FROM "pg_catalog"."pg_AUTHID"` | admit | R 42P01, S 42P01 | QUERY_FAILED 42P01 | server 42P01 | no | ok |
| shadow-057 | shadow | `SELECT * FROM PG_CATALOG.PG_AUTHID` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-058 | shadow | `SELECT a.rolpassword FROM (SELECT * FROM pg_catalog.pg_authid) a` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-059 | shadow | `WITH a AS (SELECT * FROM pg_catalog.pg_authid) SELECT * FROM a` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-060 | shadow | `SELECT * FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_authid a ON ...` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-061 | shadow | `SELECT * FROM pg_catalog.pg_roles WHERE oid IN (SELECT oid FROM pg_...` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-062 | shadow | `SELECT pg_get_userbyid(10)` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| shadow-063 | shadow | `SELECT row_to_json(a) FROM pg_catalog.pg_authid a` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-064 | shadow | `SELECT (SELECT rolpassword FROM pg_catalog.pg_authid LIMIT 1)` | refuse relation_secret | R ok(1), S ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-065 | shadow | `SELECT rolpassword FROM pg_catalog.pg_authid` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-066 | shadow | `SELECT * FROM ROWS FROM (generate_series(1,2))` | admit | R ok(2), S ok(2) | rows 2 | nothing (ran) | no | ok |
| shadow-067 | shadow | `SELECT * FROM generate_series(1,3) g` | admit | R ok(3), S ok(3) | rows 3 | nothing (ran) | no | ok |
| shadow-068 | shadow | `SELECT * FROM generate_series(1,3)` | admit | R ok(3), S ok(3) | rows 3 | nothing (ran) | no | ok |
| shadow-069 | shadow | `SELECT * FROM generate_series(1,3) AS g(x)` | admit | R ok(3), S ok(3) | rows 3 | nothing (ran) | no | ok |
| shadow-070 | shadow | `SELECT g.pg_sleep FROM generate_series(1,3) g` | refuse function | R 57014, S 57014 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-071 | shadow | `SELECT * FROM xmltable('/a' PASSING '<a/>'::xml COLUMNS x text PATH...` | refuse syntax | R 42601, S 42601 | PARSE_ERROR | guard | no | ok |
| shadow-072 | shadow | `SELECT * FROM public.accounts TABLESAMPLE system_rows(1)` | refuse node | R 42704, S 42704 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-073 | shadow | `SELECT * FROM public.accounts TABLESAMPLE bernoulli(10)` | refuse node | 16:R ok(0), S ok(0) 17:R ok(0), S ok(0) 18:R ok(2), S ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-074 | shadow | `SELECT * FROM json_table('[]', '$' COLUMNS (a int PATH '$'))` | 16:refuse syntax 17:refuse node 18:refuse node | 16:R 42601, S 42601 17:R ok(1), S ok(1) 18:R ok(1), S ok(1) | 16:PARSE_ERROR 17:CONSTRUCT_UNSUPPORTED 18:CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-075 | shadow | `SELECT json_serialize('{}')` | 16:refuse function 17:refuse node 18:refuse node | 16:R 42883, S 42883 17:R ok(1), S ok(1) 18:R ok(1), S ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-076 | shadow | `SELECT JSON_VALUE('{}', '$')` | 16:refuse function 17:refuse node 18:refuse node | 16:R 42883, S 42883 17:R ok(1), S ok(1) 18:R ok(1), S ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| shadow-077 | shadow | `SELECT 1 FROM public.accounts WHERE id = ANY (ARRAY(SELECT id FROM ...` | admit | R ok(5), S ok(5) | rows 5 | nothing (ran) | no | ok |
| secret-001 | secret | `SELECT * FROM pg_catalog.pg_largeobject` | admit | R ok(0), S ok(0) | rows 0 | nothing (ran) | no | ok |
| secret-002 | secret | `SELECT * FROM pg_catalog.pg_stat_statements` | admit | R 42P01, S 42P01 | QUERY_FAILED 42P01 | server 42P01 | no | ok |
| secret-003 | secret | `SELECT * FROM public.pg_stat_statements` | admit | R 42P01, S 42P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-004 | secret | `SELECT * FROM pg_catalog.pg_statistic_ext_data` | refuse relation_secret | R ok(0), S ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-005 | secret | `SELECT * FROM pg_catalog.pg_stats_ext` | refuse relation_secret | R ok(0), S ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-006 | secret | `SELECT * FROM pg_catalog.pg_stats_ext_exprs` | refuse relation_secret | R ok(0), S ok(0) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-007 | secret | `SELECT * FROM pg_catalog.pg_replication_origin_status` | admit | R 42501, S ok(0) | QUERY_FAILED 42501 | server role | no | ok |
| secret-008 | secret | `SELECT * FROM pg_catalog.pg_seclabel` | admit | R ok(0), S ok(0) | rows 0 | nothing (ran) | no | ok |
| secret-009 | secret | `SELECT * FROM pg_catalog.pg_shseclabel` | admit | R ok(0), S ok(0) | rows 0 | nothing (ran) | no | ok |
| secret-010 | secret | `SELECT * FROM pg_catalog.pg_stat_gssapi` | admit | 16:R ok(1), S ok(3) 17:R ok(1), S ok(3) 18:R ok(1), S ok(2) | rows 1 | nothing (ran) | no | ok |
| secret-011 | secret | `SELECT * FROM pg_catalog.pg_stat_subscription` | admit | R ok(0), S ok(0) | rows 0 | nothing (ran) | no | ok |
| secret-012 | secret | `SELECT * FROM pg_catalog.pg_publication` | admit | R ok(0), S ok(0) | rows 0 | nothing (ran) | no | ok |
| secret-013 | secret | `SELECT * FROM pg_catalog.pg_subscription_rel` | admit | R ok(0), S ok(0) | rows 0 | nothing (ran) | no | ok |
| secret-014 | secret | `SELECT * FROM pg_catalog.pg_stat_database` | admit | 16:R ok(12), S ok(12) 17:R ok(19), S ok(19) 18:R ok(11), S ok(11) | 16:rows 12 17:rows 19 18:rows 11 | nothing (ran) | no | ok |
| secret-015 | secret | `SELECT * FROM pg_catalog.pg_stat_bgwriter` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| secret-016 | secret | `SELECT * FROM pg_catalog.pg_available_extensions` | admit | 16:R ok(48), S ok(48) 17:R ok(46), S ok(46) 18:R ok(47), S ok(47) | 16:rows 48 17:rows 46 18:rows 47 | nothing (ran) | no | ok |
| secret-017 | secret | `SELECT * FROM pg_catalog.pg_timezone_names` | admit | R ok(1198), S ok(1198) | rows 500 (truncated) | nothing (ran) | no | ok |
| secret-018 | secret | `SELECT * FROM pg_catalog.pg_cursors` | admit | R ok(1), S ok(1) | rows 2 | nothing (ran) | no | ok |
| secret-019 | secret | `SELECT * FROM pg_catalog.pg_prepared_statements` | admit | R ok(0), S ok(0) | rows 0 | nothing (ran) | no | ok |
| secret-020 | secret | `SELECT * FROM pg_catalog.pg_user` | admit | R ok(6), S ok(6) | rows 6 | nothing (ran) | no | ok |
| secret-021 | secret | `SELECT * FROM pg_catalog.pg_group` | admit | 16:R ok(15), S ok(15) 17:R ok(17), S ok(17) 18:R ok(17), S ok(17) | 16:rows 15 17:rows 17 18:rows 17 | nothing (ran) | no | ok |
| secret-022 | secret | `SELECT * FROM pg_catalog.pg_tablespace` | admit | R ok(2), S ok(2) | rows 2 | nothing (ran) | no | ok |
| secret-023 | secret | `SELECT * FROM pg_catalog.pg_event_trigger` | admit | R ok(0), S ok(0) | rows 0 | nothing (ran) | no | ok |
| secret-024 | secret | `SELECT * FROM pg_catalog.pg_rules` | admit | R ok(2), S ok(2) | rows 2 | nothing (ran) | no | ok |
| secret-025 | secret | `SELECT * FROM pg_catalog.pg_policies` | admit | R ok(0), S ok(0) | rows 0 | nothing (ran) | no | ok |
| secret-026 | secret | `SELECT * FROM pg_catalog.pg_matviews` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| secret-027 | secret | `SELECT * FROM pg_catalog.pg_views` | admit | 16:R ok(145), S ok(145) 17:R ok(147), S ok(147) 18:R ok(149), S ok(149) | 16:rows 145 17:rows 147 18:rows 149 | nothing (ran) | no | ok |
| secret-028 | secret | `SELECT * FROM U&"pg_\0061uthid"` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-029 | secret | `SELECT * FROM pg_catalog.U&"pg_auth\0069d"` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-030 | secret | `SELECT * FROM pg_catalog . pg_authid` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-031 | secret | `SELECT * FROM pg_catalog/**/.pg_authid` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-032 | secret | `SELECT * FROM ONLY pg_catalog.pg_authid` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-033 | secret | `SELECT * FROM pg_catalog.pg_authid AS a` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-034 | secret | `SELECT * FROM (SELECT 1) x, LATERAL (SELECT * FROM pg_catalog.pg_au...` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-035 | secret | `SELECT a FROM pg_catalog.pg_authid a` | refuse relation_secret | 16:R ok(21), S ok(21) 17:R ok(23), S ok(23) 18:R ok(23), S ok(23) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-036 | secret | `SELECT 1 WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_authid)` | refuse relation_secret | R ok(1), S ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-037 | secret | `SELECT * FROM postgres.pg_catalog.pg_authid` | refuse relation_secret | R 0A000, S 0A000 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-038 | secret | `SELECT * FROM pg_toast.pg_toast_1260` | admit | 16:R ok(0), S ok(0) 17:R ok(0), S ok(0) 18:R 42P01, S 42P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-039 | secret | `SELECT * FROM pg_toast.pg_toast_2619` | admit | 16:R ok(13), S ok(13) 17:R ok(13), S ok(13) 18:R ok(14), S ok(14) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-040 | secret | `SELECT (SELECT string_agg(x::text, ',') FROM (SELECT * FROM pg_cata...` | refuse relation_secret | R ok(1), S ok(1) | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-041 | secret | `SELECT * FROM public.pg_authid` | admit | R 42P01, S 42P01 | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| secret-042 | secret | `SELECT * FROM pg_catalog.pg_class c WHERE c.oid = 1260` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| secret-043 | secret | `SELECT relname FROM pg_catalog.pg_class WHERE relname LIKE 'pg\_auth%'` | admit | R ok(8), S ok(8) | rows 8 | nothing (ran) | no | ok |
| secret-044 | secret | `SELECT 'pg_authid'::regclass` | admit | R ok(1), S ok(1) | rows 1 | nothing (ran) | no | ok |
| secret-045 | secret | `SELECT * FROM pg_catalog.pg_stat_user_tables` | admit | R ok(4), S ok(4) | rows 4 | nothing (ran) | no | ok |
| secret-046 | secret | `SELECT * FROM information_schema.role_table_grants` | admit | 16:R ok(0), S ok(1724) 17:R ok(0), S ok(1740) 18:R ok(0), S ok(1756) | rows 0 | nothing (ran) | no | ok |
| secret-047 | secret | `SELECT * FROM information_schema.routines` | admit | 16:R ok(3286), S ok(3350) 17:R ok(3319), S ok(3383) 18:R ok(3398), S ok(3466) | rows 500 (truncated) | nothing (ran) | no | ok |
| explain-agent-001 | explain-agent | `SELECT 1` | admit | R n/a, S n/a | explain | nothing (ran) | no | ok |
| explain-agent-002 | explain-agent | `SELECT * FROM public.accounts` | admit | R n/a, S n/a | explain | nothing (ran) | no | ok |
| explain-agent-003 | explain-agent | `SELECT * FROM public.accounts WHERE id = 1` | admit | R n/a, S n/a | explain | nothing (ran) | no | ok |
| explain-agent-004 | explain-agent | `DELETE FROM public.accounts` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-005 | explain-agent | `INSERT INTO public.accounts VALUES (96, 'x', 'x')` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-006 | explain-agent | `UPDATE public.accounts SET note = 'x'` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-007 | explain-agent | `TRUNCATE public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-008 | explain-agent | `CREATE TABLE public.d2_exp AS SELECT 1` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-009 | explain-agent | `SELECT * INTO public.d2_exp3 FROM public.accounts` | refuse select_into | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-010 | explain-agent | `WITH x AS (DELETE FROM public.accounts RETURNING 1) SELECT * FROM x` | refuse data_modifying | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-011 | explain-agent | `SELECT nextval('public.s')` | refuse function | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-agent-012 | explain-agent | `SELECT pg_sleep(1)` | refuse function | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-agent-013 | explain-agent | `SELECT public.writer()` | refuse function | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-agent-014 | explain-agent | `SELECT * FROM public.accounts FOR UPDATE` | refuse locking_clause | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-015 | explain-agent | `SELECT * FROM public.v` | admit | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-agent-016 | explain-agent | `EXPLAIN SELECT 1` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-017 | explain-agent | `EXPLAIN ANALYZE DELETE FROM public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-018 | explain-agent | `ANALYZE public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-019 | explain-agent | `ANALYZE SELECT 1` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-020 | explain-agent | `(ANALYZE) DELETE FROM public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-021 | explain-agent | `SELECT 1; DELETE FROM public.accounts` | refuse multiple_statements | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-agent-022 | explain-agent | `SELECT 1 /* */ ; DELETE FROM public.accounts` | refuse multiple_statements | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-agent-023 | explain-agent | `PREPARE d2p AS SELECT 1` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-024 | explain-agent | `EXECUTE d2p` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-025 | explain-agent | `DECLARE c CURSOR FOR SELECT 1` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-026 | explain-agent | `COPY public.accounts TO PROGRAM 'true'` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-027 | explain-agent | `SET transaction_read_only = off` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-028 | explain-agent | `VACUUM public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-029 | explain-agent | `REFRESH MATERIALIZED VIEW public.mv_accounts` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-030 | explain-agent | `CREATE MATERIALIZED VIEW public.d2_mv2 AS SELECT 1` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-001 | explain-agent-analyze | `SELECT 1` | admit | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-002 | explain-agent-analyze | `SELECT * FROM public.accounts` | admit | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-003 | explain-agent-analyze | `SELECT * FROM public.accounts WHERE id = 1` | admit | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-004 | explain-agent-analyze | `DELETE FROM public.accounts` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-005 | explain-agent-analyze | `INSERT INTO public.accounts VALUES (96, 'x', 'x')` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-006 | explain-agent-analyze | `UPDATE public.accounts SET note = 'x'` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-007 | explain-agent-analyze | `TRUNCATE public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-analyze-008 | explain-agent-analyze | `CREATE TABLE public.d2_exp AS SELECT 1` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-009 | explain-agent-analyze | `SELECT * INTO public.d2_exp3 FROM public.accounts` | refuse select_into | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-010 | explain-agent-analyze | `WITH x AS (DELETE FROM public.accounts RETURNING 1) SELECT * FROM x` | refuse data_modifying | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-011 | explain-agent-analyze | `SELECT nextval('public.s')` | refuse function | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-agent-analyze-012 | explain-agent-analyze | `SELECT pg_sleep(1)` | refuse function | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-agent-analyze-013 | explain-agent-analyze | `SELECT public.writer()` | refuse function | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-agent-analyze-014 | explain-agent-analyze | `SELECT * FROM public.accounts FOR UPDATE` | refuse locking_clause | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-015 | explain-agent-analyze | `SELECT * FROM public.v` | admit | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-agent-analyze-016 | explain-agent-analyze | `EXPLAIN SELECT 1` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-analyze-017 | explain-agent-analyze | `EXPLAIN ANALYZE DELETE FROM public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-analyze-018 | explain-agent-analyze | `ANALYZE public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-analyze-019 | explain-agent-analyze | `ANALYZE SELECT 1` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-analyze-020 | explain-agent-analyze | `(ANALYZE) DELETE FROM public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-analyze-021 | explain-agent-analyze | `SELECT 1; DELETE FROM public.accounts` | refuse multiple_statements | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-agent-analyze-022 | explain-agent-analyze | `SELECT 1 /* */ ; DELETE FROM public.accounts` | refuse multiple_statements | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-agent-analyze-023 | explain-agent-analyze | `PREPARE d2p AS SELECT 1` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-analyze-024 | explain-agent-analyze | `EXECUTE d2p` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-025 | explain-agent-analyze | `DECLARE c CURSOR FOR SELECT 1` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-026 | explain-agent-analyze | `COPY public.accounts TO PROGRAM 'true'` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-analyze-027 | explain-agent-analyze | `SET transaction_read_only = off` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-analyze-028 | explain-agent-analyze | `VACUUM public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-agent-analyze-029 | explain-agent-analyze | `REFRESH MATERIALIZED VIEW public.mv_accounts` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-agent-analyze-030 | explain-agent-analyze | `CREATE MATERIALIZED VIEW public.d2_mv2 AS SELECT 1` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-human-analyze-001 | explain-human-analyze | `SELECT 1` | admit | R n/a, S n/a | explain | nothing (ran) | no | ok |
| explain-human-analyze-002 | explain-human-analyze | `SELECT * FROM public.accounts` | admit | R n/a, S n/a | explain | nothing (ran) | no | ok |
| explain-human-analyze-003 | explain-human-analyze | `SELECT * FROM public.accounts WHERE id = 1` | admit | R n/a, S n/a | explain | nothing (ran) | no | ok |
| explain-human-analyze-004 | explain-human-analyze | `DELETE FROM public.accounts` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-human-analyze-005 | explain-human-analyze | `INSERT INTO public.accounts VALUES (96, 'x', 'x')` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-human-analyze-006 | explain-human-analyze | `UPDATE public.accounts SET note = 'x'` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-human-analyze-007 | explain-human-analyze | `TRUNCATE public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-human-analyze-008 | explain-human-analyze | `CREATE TABLE public.d2_exp AS SELECT 1` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-human-analyze-009 | explain-human-analyze | `SELECT * INTO public.d2_exp3 FROM public.accounts` | refuse select_into | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-human-analyze-010 | explain-human-analyze | `WITH x AS (DELETE FROM public.accounts RETURNING 1) SELECT * FROM x` | refuse data_modifying | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-human-analyze-011 | explain-human-analyze | `SELECT nextval('public.s')` | refuse function | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-human-analyze-012 | explain-human-analyze | `SELECT pg_sleep(1)` | refuse function | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-human-analyze-013 | explain-human-analyze | `SELECT public.writer()` | refuse function | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-human-analyze-014 | explain-human-analyze | `SELECT * FROM public.accounts FOR UPDATE` | refuse locking_clause | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-human-analyze-015 | explain-human-analyze | `SELECT * FROM public.v` | admit | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-human-analyze-016 | explain-human-analyze | `EXPLAIN SELECT 1` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-human-analyze-017 | explain-human-analyze | `EXPLAIN ANALYZE DELETE FROM public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-human-analyze-018 | explain-human-analyze | `ANALYZE public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-human-analyze-019 | explain-human-analyze | `ANALYZE SELECT 1` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-human-analyze-020 | explain-human-analyze | `(ANALYZE) DELETE FROM public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-human-analyze-021 | explain-human-analyze | `SELECT 1; DELETE FROM public.accounts` | refuse multiple_statements | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-human-analyze-022 | explain-human-analyze | `SELECT 1 /* */ ; DELETE FROM public.accounts` | refuse multiple_statements | R n/a, S n/a | CONSTRUCT_UNSUPPORTED | guard | no | ok |
| explain-human-analyze-023 | explain-human-analyze | `PREPARE d2p AS SELECT 1` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-human-analyze-024 | explain-human-analyze | `EXECUTE d2p` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-human-analyze-025 | explain-human-analyze | `DECLARE c CURSOR FOR SELECT 1` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-human-analyze-026 | explain-human-analyze | `COPY public.accounts TO PROGRAM 'true'` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-human-analyze-027 | explain-human-analyze | `SET transaction_read_only = off` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-human-analyze-028 | explain-human-analyze | `VACUUM public.accounts` | refuse syntax | R n/a, S n/a | PARSE_ERROR | guard | no | ok |
| explain-human-analyze-029 | explain-human-analyze | `REFRESH MATERIALIZED VIEW public.mv_accounts` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |
| explain-human-analyze-030 | explain-human-analyze | `CREATE MATERIALIZED VIEW public.d2_mv2 AS SELECT 1` | refuse statement_class | R n/a, S n/a | NOT_READ_ONLY | guard | no | ok |

## Effects of statements run WITHOUT the guard (S, Ss, R0), not product paths

A superuser or an unframed session changed the fixture. This shows which statements the guard, the extended protocol, the role or the read-only frame each have to stop.

| id | major | statement | effect |
|---|---|---|---|
| tx-023 | 16 | `ROLLBACK; SET transaction_read_only = off; DELETE FROM public.accounts` | Ss:accounts |
| tx-023 | 17 | `ROLLBACK; SET transaction_read_only = off; DELETE FROM public.accounts` | Ss:accounts |
| tx-023 | 18 | `ROLLBACK; SET transaction_read_only = off; DELETE FROM public.accounts` | Ss:accounts |
| tx-024 | 16 | `SELECT 1; COMMIT; DELETE FROM public.accounts` | Ss:accounts |
| tx-024 | 17 | `SELECT 1; COMMIT; DELETE FROM public.accounts` | Ss:accounts |
| tx-024 | 18 | `SELECT 1; COMMIT; DELETE FROM public.accounts` | Ss:accounts |
| copy-001 | 16 | `COPY (SELECT 1) TO PROGRAM 'touch /tmp/d2-marker-copy-program'` | S:marker_files:1 |
| copy-001 | 17 | `COPY (SELECT 1) TO PROGRAM 'touch /tmp/d2-marker-copy-program'` | S:marker_files:1 |
| copy-001 | 18 | `COPY (SELECT 1) TO PROGRAM 'touch /tmp/d2-marker-copy-program'` | S:marker_files:1 |
| copy-002 | 16 | `COPY public.accounts TO PROGRAM 'touch /tmp/d2-marker-copy-table'` | S:marker_files:1 |
| copy-002 | 17 | `COPY public.accounts TO PROGRAM 'touch /tmp/d2-marker-copy-table'` | S:marker_files:1 |
| copy-002 | 18 | `COPY public.accounts TO PROGRAM 'touch /tmp/d2-marker-copy-table'` | S:marker_files:1 |
| copy-004 | 16 | `COPY public.accounts TO '/tmp/d2-marker-copy-file'` | S:marker_files:1 |
| copy-004 | 17 | `COPY public.accounts TO '/tmp/d2-marker-copy-file'` | S:marker_files:1 |
| copy-004 | 18 | `COPY public.accounts TO '/tmp/d2-marker-copy-file'` | S:marker_files:1 |
| copy-005 | 16 | `COPY (SELECT 1) TO '/tmp/d2-marker-copy-file2'` | S:marker_files:1 |
| copy-005 | 17 | `COPY (SELECT 1) TO '/tmp/d2-marker-copy-file2'` | S:marker_files:1 |
| copy-005 | 18 | `COPY (SELECT 1) TO '/tmp/d2-marker-copy-file2'` | S:marker_files:1 |
| func-024 | 16 | `SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity` | S:other_sessions_terminated |
| func-024 | 17 | `SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity` | S:other_sessions_terminated |

## Catalog sweep: what pg_read_all_data adds over an ordinary login role

Every relation of pg_catalog and information_schema (tables, views, matviews) read as the reader in the frame and as a plain login role (CONNECT only); the delta is what the membership adds. A planted canary (primary_conninfo, archive_command, cluster_name set with ALTER SYSTEM) was searched in the product-path result of every delta relation the guard admits.

| major | relations | reader reads | plain role reads | delta | refused by the guard (secret list) | admitted by the guard | canary returned |
|---|---|---|---|---|---|---|---|
| 16 | 209 | 202 | 188 | 14 | is._pg_user_mappings, pg_authid, pg_shadow, pg_statistic, pg_statistic_ext_data, pg_subscription, pg_user_mapping | is._pg_foreign_data_wrappers, is._pg_foreign_servers, is._pg_foreign_table_columns, is._pg_foreign_tables, is.sql_parts, is.transforms, pg_largeobject | no |
| 17 | 211 | 204 | 190 | 14 | is._pg_user_mappings, pg_authid, pg_shadow, pg_statistic, pg_statistic_ext_data, pg_subscription, pg_user_mapping | is._pg_foreign_data_wrappers, is._pg_foreign_servers, is._pg_foreign_table_columns, is._pg_foreign_tables, is.sql_parts, is.transforms, pg_largeobject | no |
| 18 | 213 | 204 | 190 | 14 | is._pg_user_mappings, pg_authid, pg_shadow, pg_statistic, pg_statistic_ext_data, pg_subscription, pg_user_mapping | is._pg_foreign_data_wrappers, is._pg_foreign_servers, is._pg_foreign_table_columns, is._pg_foreign_tables, is.sql_parts, is.transforms, pg_largeobject | no |

## User code on the read path (a function that raises D2-SENTINEL when the reader runs it)

| major | probe | statement | outcome | verdict |
|---|---|---|---|---|
| 16 | cast-implicit | `SELECT lower(c) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 16 | cast-implicit | `SELECT count(*) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 16 | cast-json | `SELECT to_json(c) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 16 | cast-json | `SELECT row_to_json(t) FROM public.t t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 16 | cast-json | `SELECT json_agg(t) FROM public.t t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 16 | cast-json | `SELECT to_jsonb(t) FROM public.t t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 16 | index-predicate | `SELECT count(*) FROM public.t WHERE x = 1` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 16 | index-expression | `SELECT count(*) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 16 | ext-statistics | `SELECT count(*) FROM public.t WHERE x = 1` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 16 | partition-key | `SELECT count(*) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 16 | range-subtype-diff | `SELECT count(*) FROM public.t a, public.t b WHERE a.r && b.r` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 16 | domain-check | `SELECT * FROM public.t` | query | ok |
| 16 | domain-check | `SELECT count(*) FROM public.t WHERE c = 'a'` | query | ok |
| 16 | check-constraint-children | `SELECT * FROM public.p WHERE x = 5` | query | ok |
| 16 | check-constraint-children | `SELECT count(*) FROM public.p` | query | ok |
| 16 | default-trigger-policy | `SELECT * FROM public.t` | query | ok |
| 16 | default-trigger-policy | `SELECT count(*) FROM public.t` | query | ok |
| 16 | security-invoker-view | `SELECT * FROM public.vi` | QUERY_CONSTRUCT_UNSUPPORTED/relation_kind/ | ok (refused: relation_kind) |
| 17 | cast-implicit | `SELECT lower(c) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 17 | cast-implicit | `SELECT count(*) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 17 | cast-json | `SELECT to_json(c) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 17 | cast-json | `SELECT row_to_json(t) FROM public.t t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 17 | cast-json | `SELECT json_agg(t) FROM public.t t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 17 | cast-json | `SELECT to_jsonb(t) FROM public.t t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 17 | index-predicate | `SELECT count(*) FROM public.t WHERE x = 1` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 17 | index-expression | `SELECT count(*) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 17 | ext-statistics | `SELECT count(*) FROM public.t WHERE x = 1` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 17 | partition-key | `SELECT count(*) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 17 | range-subtype-diff | `SELECT count(*) FROM public.t a, public.t b WHERE a.r && b.r` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 17 | domain-check | `SELECT * FROM public.t` | query | ok |
| 17 | domain-check | `SELECT count(*) FROM public.t WHERE c = 'a'` | query | ok |
| 17 | check-constraint-children | `SELECT * FROM public.p WHERE x = 5` | query | ok |
| 17 | check-constraint-children | `SELECT count(*) FROM public.p` | query | ok |
| 17 | default-trigger-policy | `SELECT * FROM public.t` | query | ok |
| 17 | default-trigger-policy | `SELECT count(*) FROM public.t` | query | ok |
| 17 | security-invoker-view | `SELECT * FROM public.vi` | QUERY_CONSTRUCT_UNSUPPORTED/relation_kind/ | ok (refused: relation_kind) |
| 18 | cast-implicit | `SELECT lower(c) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 18 | cast-implicit | `SELECT count(*) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 18 | cast-json | `SELECT to_json(c) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 18 | cast-json | `SELECT row_to_json(t) FROM public.t t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 18 | cast-json | `SELECT json_agg(t) FROM public.t t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 18 | cast-json | `SELECT to_jsonb(t) FROM public.t t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 18 | index-predicate | `SELECT count(*) FROM public.t WHERE x = 1` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 18 | index-expression | `SELECT count(*) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 18 | ext-statistics | `SELECT count(*) FROM public.t WHERE x = 1` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 18 | partition-key | `SELECT count(*) FROM public.t` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 18 | range-subtype-diff | `SELECT count(*) FROM public.t a, public.t b WHERE a.r && b.r` | QUERY_CONSTRUCT_UNSUPPORTED/user_code/ | ok |
| 18 | virtual-generated | `(setup)` | setup refused by the server | n/a: 0A000 generation expression uses user-defined function |
| 18 | domain-check | `SELECT * FROM public.t` | query | ok |
| 18 | domain-check | `SELECT count(*) FROM public.t WHERE c = 'a'` | query | ok |
| 18 | check-constraint-children | `SELECT * FROM public.p WHERE x = 5` | query | ok |
| 18 | check-constraint-children | `SELECT count(*) FROM public.p` | query | ok |
| 18 | default-trigger-policy | `SELECT * FROM public.t` | query | ok |
| 18 | default-trigger-policy | `SELECT count(*) FROM public.t` | query | ok |
| 18 | security-invoker-view | `SELECT * FROM public.vi` | QUERY_CONSTRUCT_UNSUPPORTED/relation_kind/ | ok (refused: relation_kind) |

## Limits through the product path (executeDataRead on a real reader session; container capped at 3 GiB)

| major | scenario | statement | requested timeout ms | result | elapsed ms | temp files MB | worker RSS MB | reader backends left |
|---|---|---|---|---|---|---|---|---|
| 16 | corpus | `SELECT g FROM generate_series(1, 1000000000) g` | 2500 | QUERY_TIMEOUT | 3376 | 492 | 83 | 0 |
| 16 | corpus | `SELECT count(*) FROM generate_series(1, 1000000000000)` | 2000 | QUERY_TIMEOUT | 2203 | 395 | 71 | 0 |
| 16 | corpus | `SELECT count(*) FROM pg_catalog.pg_class a, pg_catalog.pg_` | 2500 | QUERY_TIMEOUT | 2543 | 0 | 70 | 0 |
| 16 | corpus | `SELECT g FROM generate_series(1, 100000000) g ORDER BY ran` | 2500 | QUERY_TIMEOUT | 2657 | 360 | 70 | 0 |
| 16 | corpus | `SELECT repeat('x', 100000000)` | 2500 | QUERY_RESULT_TOO_LARGE | 1960 | 0 | 106 | 0 |
| 16 | corpus | `SELECT repeat('x', 1073741823)` | 2500 | QUERY_FAILED 54000 | 220 | 0 | 89 | 0 |
| 16 | corpus | `SELECT repeat('x', 1000) FROM generate_series(1, 100000)` | 2500 | rows 500 truncated:rows | 82 | 1 | 91 | 0 |
| 16 | corpus | `SELECT string_agg(repeat('x', 1000), ',') FROM generate_se` | 2500 | QUERY_RESULT_TOO_LARGE | 1612 | 3 | 119 | 0 |
| 16 | corpus | `SELECT array_agg(g) FROM generate_series(1, 300000000) g` | 2500 | QUERY_TIMEOUT | 2663 | 318 | 139 | 0 |
| 16 | corpus | `SELECT count(*) FROM generate_series(1, 100000) g WHERE (r` | 2500 | rows 1 | 20 | 0 | 97 | 0 |
| 16 | corpus | `SELECT regexp_replace(repeat('a', 100000), '(a\|aa)+$', 'b'` | 2500 | rows 1 | 26 | 0 | 98 | 0 |
| 16 | corpus | `WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FR` | 2500 | rows 500 truncated:rows | 37 | 0 | 98 | 0 |
| 16 | corpus | `WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FR` | 2500 | QUERY_TIMEOUT | 2586 | 58 | 98 | 0 |
| 16 | corpus | `SELECT jsonb_agg(to_jsonb(g)) FROM generate_series(1, 5000` | 2500 | QUERY_TIMEOUT | 2757 | 167 | 98 | 0 |
| 16 | corpus | `SELECT g FROM generate_series(1, 5) g, generate_series(1, ` | 2500 | rows 25 | 129 | 0 | 71 | 0 |
| 16 | human-rows | `SELECT g FROM generate_series(1, 1000000000) g` | 2500 | QUERY_TIMEOUT | 2640 | 277 | 72 | 0 |
| 16 | human-bytes-100MB | `SELECT repeat('x', 1000) FROM generate_series(1, 100000)` | 5000 | rows 5000 truncated:rows | 231 | 1 | 88 | 0 |
| 16 | human-bytes-500MB | `SELECT repeat('x', 5000) FROM generate_series(1, 100000)` | 5000 | rows 1047 truncated:bytes | 196 | 1 | 126 | 0 |
| 16 | human-explain-analyze | `SELECT count(*) FROM generate_series(1, 1000000000000)` | 2500 | QUERY_TIMEOUT | 2738 | 489 | 140 | 0 |
| 16 | cancel-mid-run | `SELECT count(*) FROM generate_series(1, 1000000000000)` | 30000 | QUERY_CANCELED | 563 | 72 | 81 | 0 |
| 16 | cancel-before-start | `SELECT 1` | 5000 | QUERY_CANCELED | 7 | 0 | 81 | 0 |
| 16 | after-cancel | `SELECT count(*) FROM public.accounts` | 5000 | rows 1 | 36 | 0 | 81 | 0 |
| 16 | lock-timeout | `SELECT count(*) FROM public.accounts` | 10000 | QUERY_TIMEOUT | 1016 | 0 | 81 | 0 |
| 16 | error-text | `SELECT 1/0` | 4000 | QUERY_FAILED 22012 | 10 | 0 | 81 | 0 |
| 16 | error-text | `SELECT * FROM public.nonexistent` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (relation_kind) | 3 | 0 | 81 | 0 |
| 16 | error-text | `SELECT 'x'::int` | 4000 | QUERY_FAILED 22P02 | 13 | 0 | 81 | 0 |
| 16 | error-text | `SELECT (SELECT 1 UNION ALL SELECT 2)` | 4000 | QUERY_FAILED 21000 | 11 | 0 | 81 | 0 |
| 16 | error-text | `SELECT current_setting('d2.nonexistent')` | 4000 | QUERY_FAILED 42704 | 9 | 0 | 81 | 0 |
| 16 | error-text | `SELECT * FROM public.accounts WHERE id = 'a'` | 4000 | QUERY_FAILED 22P02 | 13 | 0 | 81 | 0 |
| 16 | error-text | `SELECT pg_read_file('/etc/passwd')` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (function) | 1 | 0 | 81 | 0 |
| 16 | error-text | `SELECT * FROM pg_catalog.pg_authid` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (relation_secret) | 0 | 0 | 81 | 0 |
| 16 | error-text | `SELECT * FROM public.ft_passwd` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (relation_kind) | 2 | 0 | 76 | 0 |
| 16 | error-text | `SELECT * FROM public.accounts WHERE note ~ '('` | 4000 | QUERY_FAILED 2201B | 15 | 0 | 76 | 0 |
| 16 | error-text | `SELECT to_char(1, repeat('9', 100000))` | 4000 | rows 1 | 23 | 0 | 76 | 0 |
| 16 | error-text | `SELECT lo_import('/etc/passwd')` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (function) | 1 | 0 | 76 | 0 |
| 16 | error-text | `SELECT dblink_connect('host=127.0.0.1 port=5432 dbname=pos` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (function) | 1 | 0 | 76 | 0 |
| 16 | error-text | `SELECT inet_server_addr(), inet_server_port(), version()` | 4000 | rows 1 | 14 | 0 | 76 | 0 |
| 16 | memory | `SELECT array_agg(g) FROM generate_series(1, 2000000000) g` | 8000 | QUERY_TIMEOUT | 9733 | 1667 | 76 | 0 |
| 16 | memory | `SELECT string_agg(repeat('y', 100000), ',') FROM generate_` | 8000 | QUERY_FAILED 54000 | 1309 | 1 | 76 | 0 |
| 16 | memory | `SELECT jsonb_agg(repeat('y', 100)) FROM generate_series(1,` | 8000 | QUERY_TIMEOUT | 9494 | 1612 | 76 | 0 |
| 17 | corpus | `SELECT g FROM generate_series(1, 1000000000) g` | 2500 | QUERY_TIMEOUT | 2977 | 518 | 93 | 0 |
| 17 | corpus | `SELECT count(*) FROM generate_series(1, 1000000000000)` | 2000 | QUERY_TIMEOUT | 2659 | 500 | 86 | 0 |
| 17 | corpus | `SELECT count(*) FROM pg_catalog.pg_class a, pg_catalog.pg_` | 2500 | QUERY_TIMEOUT | 2515 | 0 | 84 | 0 |
| 17 | corpus | `SELECT g FROM generate_series(1, 100000000) g ORDER BY ran` | 2500 | QUERY_TIMEOUT | 2709 | 457 | 85 | 0 |
| 17 | corpus | `SELECT repeat('x', 100000000)` | 2500 | QUERY_RESULT_TOO_LARGE | 918 | 0 | 114 | 0 |
| 17 | corpus | `SELECT repeat('x', 1073741823)` | 2500 | QUERY_FAILED 54000 | 17 | 0 | 132 | 0 |
| 17 | corpus | `SELECT repeat('x', 1000) FROM generate_series(1, 100000)` | 2500 | rows 500 truncated:rows | 55 | 1 | 132 | 0 |
| 17 | corpus | `SELECT string_agg(repeat('x', 1000), ',') FROM generate_se` | 2500 | QUERY_RESULT_TOO_LARGE | 1161 | 3 | 179 | 0 |
| 17 | corpus | `SELECT array_agg(g) FROM generate_series(1, 300000000) g` | 2500 | QUERY_TIMEOUT | 2766 | 282 | 186 | 0 |
| 17 | corpus | `SELECT count(*) FROM generate_series(1, 100000) g WHERE (r` | 2500 | rows 1 | 92 | 0 | 186 | 0 |
| 17 | corpus | `SELECT regexp_replace(repeat('a', 100000), '(a\|aa)+$', 'b'` | 2500 | rows 1 | 61 | 0 | 186 | 0 |
| 17 | corpus | `WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FR` | 2500 | rows 500 truncated:rows | 89 | 0 | 187 | 0 |
| 17 | corpus | `WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FR` | 2500 | QUERY_TIMEOUT | 2595 | 81 | 187 | 0 |
| 17 | corpus | `SELECT jsonb_agg(to_jsonb(g)) FROM generate_series(1, 5000` | 2500 | QUERY_TIMEOUT | 2688 | 284 | 81 | 0 |
| 17 | corpus | `SELECT g FROM generate_series(1, 5) g, generate_series(1, ` | 2500 | rows 25 | 88 | 0 | 81 | 0 |
| 17 | human-rows | `SELECT g FROM generate_series(1, 1000000000) g` | 2500 | QUERY_TIMEOUT | 2711 | 432 | 81 | 0 |
| 17 | human-bytes-100MB | `SELECT repeat('x', 1000) FROM generate_series(1, 100000)` | 5000 | rows 5000 truncated:rows | 365 | 1 | 95 | 0 |
| 17 | human-bytes-500MB | `SELECT repeat('x', 5000) FROM generate_series(1, 100000)` | 5000 | rows 1047 truncated:bytes | 177 | 1 | 130 | 0 |
| 17 | human-explain-analyze | `SELECT count(*) FROM generate_series(1, 1000000000000)` | 2500 | QUERY_TIMEOUT | 2730 | 427 | 117 | 0 |
| 17 | cancel-mid-run | `SELECT count(*) FROM generate_series(1, 1000000000000)` | 30000 | QUERY_CANCELED | 445 | 43 | 88 | 0 |
| 17 | cancel-before-start | `SELECT 1` | 5000 | QUERY_CANCELED | 11 | 0 | 88 | 0 |
| 17 | after-cancel | `SELECT count(*) FROM public.accounts` | 5000 | rows 1 | 43 | 0 | 88 | 0 |
| 17 | lock-timeout | `SELECT count(*) FROM public.accounts` | 10000 | QUERY_TIMEOUT | 1082 | 0 | 88 | 0 |
| 17 | error-text | `SELECT 1/0` | 4000 | QUERY_FAILED 22012 | 18 | 0 | 88 | 0 |
| 17 | error-text | `SELECT * FROM public.nonexistent` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (relation_kind) | 3 | 0 | 88 | 0 |
| 17 | error-text | `SELECT 'x'::int` | 4000 | QUERY_FAILED 22P02 | 56 | 0 | 88 | 0 |
| 17 | error-text | `SELECT (SELECT 1 UNION ALL SELECT 2)` | 4000 | QUERY_FAILED 21000 | 75 | 0 | 88 | 0 |
| 17 | error-text | `SELECT current_setting('d2.nonexistent')` | 4000 | QUERY_FAILED 42704 | 29 | 0 | 88 | 0 |
| 17 | error-text | `SELECT * FROM public.accounts WHERE id = 'a'` | 4000 | QUERY_FAILED 22P02 | 16 | 0 | 83 | 0 |
| 17 | error-text | `SELECT pg_read_file('/etc/passwd')` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (function) | 1 | 0 | 83 | 0 |
| 17 | error-text | `SELECT * FROM pg_catalog.pg_authid` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (relation_secret) | 0 | 0 | 83 | 0 |
| 17 | error-text | `SELECT * FROM public.ft_passwd` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (relation_kind) | 5 | 0 | 83 | 0 |
| 17 | error-text | `SELECT * FROM public.accounts WHERE note ~ '('` | 4000 | QUERY_FAILED 2201B | 17 | 0 | 83 | 0 |
| 17 | error-text | `SELECT to_char(1, repeat('9', 100000))` | 4000 | rows 1 | 74 | 0 | 83 | 0 |
| 17 | error-text | `SELECT lo_import('/etc/passwd')` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (function) | 1 | 0 | 82 | 0 |
| 17 | error-text | `SELECT dblink_connect('host=127.0.0.1 port=5432 dbname=pos` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (function) | 0 | 0 | 82 | 0 |
| 17 | error-text | `SELECT inet_server_addr(), inet_server_port(), version()` | 4000 | rows 1 | 82 | 0 | 82 | 0 |
| 17 | memory | `SELECT array_agg(g) FROM generate_series(1, 2000000000) g` | 8000 | QUERY_TIMEOUT | 8527 | 1256 | 82 | 0 |
| 17 | memory | `SELECT string_agg(repeat('y', 100000), ',') FROM generate_` | 8000 | QUERY_FAILED 54000 | 1410 | 1 | 82 | 0 |
| 17 | memory | `SELECT jsonb_agg(repeat('y', 100)) FROM generate_series(1,` | 8000 | QUERY_TIMEOUT | 8513 | 1142 | 82 | 0 |
| 18 | corpus | `SELECT g FROM generate_series(1, 1000000000) g` | 2500 | QUERY_TIMEOUT | 2902 | 318 | 108 | 0 |
| 18 | corpus | `SELECT count(*) FROM generate_series(1, 1000000000000)` | 2000 | QUERY_TIMEOUT | 2308 | 307 | 93 | 0 |
| 18 | corpus | `SELECT count(*) FROM pg_catalog.pg_class a, pg_catalog.pg_` | 2500 | QUERY_TIMEOUT | 2662 | 0 | 92 | 0 |
| 18 | corpus | `SELECT g FROM generate_series(1, 100000000) g ORDER BY ran` | 2500 | QUERY_TIMEOUT | 2714 | 378 | 92 | 0 |
| 18 | corpus | `SELECT repeat('x', 100000000)` | 2500 | QUERY_RESULT_TOO_LARGE | 1098 | 0 | 134 | 0 |
| 18 | corpus | `SELECT repeat('x', 1073741823)` | 2500 | QUERY_FAILED 54000 | 62 | 0 | 139 | 0 |
| 18 | corpus | `SELECT repeat('x', 1000) FROM generate_series(1, 100000)` | 2500 | rows 500 truncated:rows | 547 | 0 | 141 | 0 |
| 18 | corpus | `SELECT string_agg(repeat('x', 1000), ',') FROM generate_se` | 2500 | QUERY_RESULT_TOO_LARGE | 1082 | 3 | 186 | 0 |
| 18 | corpus | `SELECT array_agg(g) FROM generate_series(1, 300000000) g` | 2500 | QUERY_TIMEOUT | 2738 | 403 | 192 | 0 |
| 18 | corpus | `SELECT count(*) FROM generate_series(1, 100000) g WHERE (r` | 2500 | rows 1 | 15 | 0 | 88 | 0 |
| 18 | corpus | `SELECT regexp_replace(repeat('a', 100000), '(a\|aa)+$', 'b'` | 2500 | rows 1 | 19 | 0 | 89 | 0 |
| 18 | corpus | `WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FR` | 2500 | rows 500 truncated:rows | 113 | 0 | 89 | 0 |
| 18 | corpus | `WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FR` | 2500 | QUERY_TIMEOUT | 2568 | 129 | 89 | 0 |
| 18 | corpus | `SELECT jsonb_agg(to_jsonb(g)) FROM generate_series(1, 5000` | 2500 | QUERY_TIMEOUT | 2664 | 406 | 89 | 0 |
| 18 | corpus | `SELECT g FROM generate_series(1, 5) g, generate_series(1, ` | 2500 | rows 25 | 18 | 0 | 88 | 0 |
| 18 | human-rows | `SELECT g FROM generate_series(1, 1000000000) g` | 2500 | QUERY_TIMEOUT | 2689 | 416 | 89 | 0 |
| 18 | human-bytes-100MB | `SELECT repeat('x', 1000) FROM generate_series(1, 100000)` | 5000 | rows 5000 truncated:rows | 459 | 0 | 105 | 0 |
| 18 | human-bytes-500MB | `SELECT repeat('x', 5000) FROM generate_series(1, 100000)` | 5000 | rows 1047 truncated:bytes | 152 | 0 | 125 | 0 |
| 18 | human-explain-analyze | `SELECT count(*) FROM generate_series(1, 1000000000000)` | 2500 | QUERY_TIMEOUT | 2694 | 349 | 125 | 0 |
| 18 | cancel-mid-run | `SELECT count(*) FROM generate_series(1, 1000000000000)` | 30000 | QUERY_CANCELED | 502 | 54 | 102 | 0 |
| 18 | cancel-before-start | `SELECT 1` | 5000 | QUERY_CANCELED | 7 | 0 | 102 | 0 |
| 18 | after-cancel | `SELECT count(*) FROM public.accounts` | 5000 | rows 1 | 24 | 0 | 102 | 0 |
| 18 | lock-timeout | `SELECT count(*) FROM public.accounts` | 10000 | QUERY_TIMEOUT | 1018 | 0 | 102 | 0 |
| 18 | error-text | `SELECT 1/0` | 4000 | QUERY_FAILED 22012 | 12 | 0 | 102 | 0 |
| 18 | error-text | `SELECT * FROM public.nonexistent` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (relation_kind) | 3 | 0 | 102 | 0 |
| 18 | error-text | `SELECT 'x'::int` | 4000 | QUERY_FAILED 22P02 | 13 | 0 | 102 | 0 |
| 18 | error-text | `SELECT (SELECT 1 UNION ALL SELECT 2)` | 4000 | QUERY_FAILED 21000 | 18 | 0 | 102 | 0 |
| 18 | error-text | `SELECT current_setting('d2.nonexistent')` | 4000 | QUERY_FAILED 42704 | 22 | 0 | 102 | 0 |
| 18 | error-text | `SELECT * FROM public.accounts WHERE id = 'a'` | 4000 | QUERY_FAILED 22P02 | 17 | 0 | 102 | 0 |
| 18 | error-text | `SELECT pg_read_file('/etc/passwd')` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (function) | 0 | 0 | 102 | 0 |
| 18 | error-text | `SELECT * FROM pg_catalog.pg_authid` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (relation_secret) | 0 | 0 | 102 | 0 |
| 18 | error-text | `SELECT * FROM public.ft_passwd` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (relation_kind) | 4 | 0 | 102 | 0 |
| 18 | error-text | `SELECT * FROM public.accounts WHERE note ~ '('` | 4000 | QUERY_FAILED 2201B | 13 | 0 | 101 | 0 |
| 18 | error-text | `SELECT to_char(1, repeat('9', 100000))` | 4000 | rows 1 | 19 | 0 | 91 | 0 |
| 18 | error-text | `SELECT lo_import('/etc/passwd')` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (function) | 1 | 0 | 91 | 0 |
| 18 | error-text | `SELECT dblink_connect('host=127.0.0.1 port=5432 dbname=pos` | 4000 | QUERY_CONSTRUCT_UNSUPPORTED (function) | 1 | 0 | 91 | 0 |
| 18 | error-text | `SELECT inet_server_addr(), inet_server_port(), version()` | 4000 | rows 1 | 13 | 0 | 91 | 0 |
| 18 | memory | `SELECT array_agg(g) FROM generate_series(1, 2000000000) g` | 8000 | QUERY_TIMEOUT | 8471 | 1579 | 91 | 0 |
| 18 | memory | `SELECT string_agg(repeat('y', 100000), ',') FROM generate_` | 8000 | QUERY_FAILED 54000 | 1030 | 0 | 90 | 0 |
| 18 | memory | `SELECT jsonb_agg(repeat('y', 100)) FROM generate_series(1,` | 8000 | QUERY_TIMEOUT | 8455 | 1329 | 90 | 0 |

## Exhaustion of the target and a dead backend

- bomb-pg17.jsonl / temp-files-15s: `SELECT g FROM generate_series(1, 1000000000) g` -> QUERY_TIMEOUT; peak container memory 2664 MB; oom kills 0; bystander session survived: true; temp dir peak 2262 MB
- bomb-pg17.jsonl / big-values-streaming: `SELECT sum(length(repeat('x', 500000000))) FROM generate_series(1, 6)` -> query; peak container memory 842 MB; oom kills 0; bystander session survived: true
- bomb-pg17.jsonl / aggregate-of-big-values: `SELECT array_agg(repeat('x', 100000000)) FROM generate_series(1, 100)` -> HUNG: no result 100 s after the start (statement timeout was 60 s); peak container memory 3069 MB; oom kills 1; bystander session survived: false
- crash-pg16-sigterm.json: mode sigterm, statement timeout 60 s -> returned false, NO RESULT within 80 s of the kill, 80102 ms after the kill
- crash-pg16-kill9.json: mode kill9, statement timeout 60 s -> returned false, NO RESULT within 80 s of the kill, 80102 ms after the kill
- temp_file_limit (unset: product bootstrap): QUERY_TIMEOUT after 8570 ms, temp dir peak 1569 MB
- temp_file_limit 256MB: QUERY_FAILED 53400 after 1207 ms, temp dir peak 239 MB
- pg + pg-cursor only: read rejected: terminating connection due to administrator command / close() still pending after 10 s

## What the reader role alone allows (guard and read-only frame both escaped; simple protocol, after SET default_transaction_read_only = off)

| attempt | statement | outcome |
|---|---|---|
| write a table row | `INSERT INTO public.accounts VALUES (2, 'two')` | refused 42501 |
| update a table row | `UPDATE public.accounts SET note = 'x'` | refused 42501 |
| delete table rows | `DELETE FROM public.accounts` | refused 42501 |
| truncate | `TRUNCATE public.accounts` | refused 42501 |
| create a table in public | `CREATE TABLE public.d2_new (a int)` | refused 42501 |
| create a schema | `CREATE SCHEMA d2_new` | refused 42501 |
| advance a sequence | `SELECT nextval('public.s')` | refused 42501 |
| create a temporary table and write it | `CREATE TEMP TABLE d2_tmp (a int); INSERT INTO d2_tmp VALUES (1)` | ALLOWED |
| create a large object | `SELECT lo_create(0)` | ALLOWED |
| take an advisory lock | `SELECT pg_advisory_lock(1)` | ALLOWED |
| send a notification | `SELECT pg_notify('d2', 'x')` | ALLOWED |
| read a server file | `SELECT pg_read_file('/etc/passwd')` | refused 42501 |
| COPY to a program | `COPY (SELECT 1) TO PROGRAM 'true'` | refused 42501 |
| become another role | `SET ROLE postgres` | refused 42501 |
| alter itself | `ALTER ROLE exponetdb_reader SUPERUSER` | refused 42501 |
| terminate another backend | `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg` | refused 42501 |

## Through /mcp and REST (the real program: sealed lane, worker, reader session on PostgreSQL 17)

157 statements sent through sql_query / sql_explain (an agent over MCP) and POST /targets/{id}/queries and /explain (a person over REST); expectation failures: 0.

Backend termination mid-read through the lane: {"backendsTerminated":2,"bothReadsAnsweredWithin25s":false,"bothAnsweredAfterLaneGaveUp":true,"msUntilAnswered":147156,"answers":["read 0: tools/call sql_query: 504 {\"jsonrpc\":\"2.0\",\"id\":158,\"error\":{\"code\":-32603,\"message\":\"The  after 91012 ms","read 1: tools/call sql_query: 504 {\"jsonrpc\":\"2.0\",\"id\":159,\"error\":{\"code\":-32603,\"message\":\"The  after 91029 ms"],"nextReadAfterwards":"error: Refused: TARGET_UNAVAILABLE.\n{\"code\":\"TARGET_UNAVAILABLE\",\"message\":\"ExponetDB c"}

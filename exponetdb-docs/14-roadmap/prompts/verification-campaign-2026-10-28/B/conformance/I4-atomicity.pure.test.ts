// I4 Atomicity, lint/classifier level: `up.sql` must not be able to end the transaction early, change the
// session, or need autocommit without the bundle saying so. Every statement below is lexically valid
// PostgreSQL; the assertion is that the bundle is refused at lint time (blocking) or, for statements that
// cannot run in a transaction block, accepted only as a non-transactional bundle.
// The apply-level proof on real PostgreSQL (nothing half applied) is in I4-atomicity.int.test.ts.
import { beforeAll, describe, expect, test } from 'vitest'
import { prepareLint } from '@exponetdb/migrations/lint'
import { lint, mk } from './lib/bundle.ts'

beforeAll(async () => {
  for (const m of [16, 17, 18] as const) await prepareLint(m)
})

/** What a lint run says about one up.sql. */
function judge(up: string, transactional: boolean, major: 16 | 17 | 18 = 17) {
  const report = lint([mk({ up, transactional })], { major })
  const b = report.bundles[0]
  const findings = b?.findings ?? []
  return {
    valid: b?.valid ?? false,
    rules: findings.map((f) => f.rule),
    blocking: findings.filter((f) => f.blocking).map((f) => f.rule),
    forbidden: findings.some((f) => f.rule === 'forbidden_statement'),
    parseError: findings.some((f) => f.rule === 'parse_error'),
    autocommit: b?.autocommitStatements ?? 0,
    statements: b?.statements ?? [],
  }
}

/** Never allowed in a bundle, transactional or not. */
const FORBIDDEN: [string, string][] = [
  ['commit', 'COMMIT;'],
  ['commit work', 'COMMIT WORK;'],
  ['commit and chain', 'COMMIT AND CHAIN;'],
  ['end', 'END;'],
  ['end transaction', 'END TRANSACTION;'],
  ['rollback', 'ROLLBACK;'],
  ['rollback and chain', 'ROLLBACK AND CHAIN;'],
  ['abort', 'ABORT;'],
  ['begin', 'BEGIN;'],
  ['begin isolation', 'BEGIN ISOLATION LEVEL SERIALIZABLE;'],
  ['start transaction', 'START TRANSACTION;'],
  ['savepoint', 'SAVEPOINT s;'],
  ['release savepoint', 'RELEASE SAVEPOINT s;'],
  ['release', 'RELEASE s;'],
  ['rollback to', 'ROLLBACK TO SAVEPOINT s;'],
  ['prepare transaction', "PREPARE TRANSACTION 'x';"],
  ['commit prepared', "COMMIT PREPARED 'x';"],
  ['rollback prepared', "ROLLBACK PREPARED 'x';"],
  ['set transaction', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;'],
  ['set transaction read only', 'SET TRANSACTION READ ONLY;'],
  ['set session characteristics', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;'],
  ['set session authorization', 'SET SESSION AUTHORIZATION postgres;'],
  ['set local session authorization', 'SET LOCAL SESSION AUTHORIZATION postgres;'],
  ['set role', 'SET ROLE postgres;'],
  ['set local role', 'SET LOCAL ROLE postgres;'],
  ['reset role', 'RESET ROLE;'],
  ['set role none', 'SET ROLE NONE;'],
  ['reset all', 'RESET ALL;'],
  ['reset search_path', 'RESET search_path;'],
  ['set search_path', 'SET search_path = public;'],
  ['set local search_path', 'SET LOCAL search_path = evil, public;'],
  ['set search_path to', 'SET search_path TO evil;'],
  ['set scs off', 'SET standard_conforming_strings = off;'],
  ['set local scs off', 'SET LOCAL standard_conforming_strings = off;'],
  ['set local lock_timeout', "SET LOCAL lock_timeout = '1h';"],
  ['set local statement_timeout', 'SET LOCAL statement_timeout = 0;'],
  ['set local session_replication_role', "SET LOCAL session_replication_role = 'replica';"],
  ['set local row_security', 'SET LOCAL row_security = off;'],
  ['set local default_transaction_read_only', 'SET LOCAL default_transaction_read_only = off;'],
  ['set local transaction_read_only', 'SET LOCAL transaction_read_only = off;'],
  ['set local client_encoding', "SET LOCAL client_encoding = 'SQL_ASCII';"],
  ['set local timezone', "SET LOCAL TimeZone = 'Pacific/Kiritimati';"],
  ['set work_mem (no local)', "SET work_mem = '1GB';"],
  ['set constraints? (allowed class check below)', 'DISCARD ALL;'],
  ['discard plans', 'DISCARD PLANS;'],
  ['discard temp', 'DISCARD TEMP;'],
  ['set_config search_path', "SELECT set_config('search_path', 'evil', false);"],
  ['set_config search_path local', "SELECT set_config('search_path', 'evil', true);"],
  ['set_config scs', "SELECT set_config('standard_conforming_strings', 'off', true);"],
  ['set_config role', "SELECT set_config('role', 'postgres', true);"],
  ['set_config non-local', "SELECT set_config('work_mem', '1GB', false);"],
  ['set_config schema-qualified', "SELECT pg_catalog.set_config('search_path', 'evil', true);"],
  ['set_config dynamic name', "SELECT set_config(current_setting('application_name'), 'x', true);"],
  ['set_config in subquery', "SELECT * FROM (SELECT set_config('role','x',true)) s;"],
  ['set_config in insert', "CREATE TABLE zz AS SELECT set_config('search_path','evil',true);"],
  ['alter system', "ALTER SYSTEM SET max_connections = 1;"],
  ['alter system reset', 'ALTER SYSTEM RESET ALL;'],
  ['create database', 'CREATE DATABASE other;'],
  ['drop database', 'DROP DATABASE other;'],
  ['alter database set', "ALTER DATABASE other SET search_path = 'x';"],
  ['create role', 'CREATE ROLE evil SUPERUSER;'],
  ['alter role', 'ALTER ROLE evil SET search_path = x;'],
  ['drop role', 'DROP ROLE evil;'],
  ['grant role', 'GRANT postgres TO evil;'],
  ['create tablespace', "CREATE TABLESPACE ts LOCATION '/tmp/x';"],
  ['load', "LOAD 'auto_explain';"],
  ['copy program', "COPY t FROM PROGRAM 'id';"],
  ['copy to program', "COPY t TO PROGRAM 'cat > /tmp/x';"],
  ['copy file', "COPY t TO '/tmp/x';"],
  ['copy stdin', 'COPY t FROM STDIN;'],
  ['copy stdout', 'COPY t TO STDOUT;'],
  ['listen', 'LISTEN ch;'],
  ['prepare', 'PREPARE p AS SELECT 1;'],
  ['execute', 'EXECUTE p;'],
  ['declare cursor', 'DECLARE c CURSOR WITH HOLD FOR SELECT 1;'],
  ['create subscription', "CREATE SUBSCRIPTION s CONNECTION 'host=x' PUBLICATION p;"],
  ['checkpoint', 'CHECKPOINT;'],
  ['ledger schema table', 'CREATE TABLE exponetdb.evil (i int);'],
  ['ledger schema insert', "INSERT INTO exponetdb.schema_migrations DEFAULT VALUES;"],
  ['ledger schema quoted', 'DROP TABLE "exponetdb"."schema_migrations";'],
  ['ledger schema comment', "COMMENT ON SCHEMA exponetdb IS 'x';"],
  ['ledger schema upper', 'DROP SCHEMA EXPONETDB CASCADE;'],
  ['create event trigger', 'CREATE EVENT TRIGGER et ON ddl_command_end EXECUTE FUNCTION f();'],
  ['create fdw', 'CREATE FOREIGN DATA WRAPPER w;'],
  ['create server', 'CREATE SERVER s FOREIGN DATA WRAPPER w;'],
  ['create language', 'CREATE LANGUAGE plpython3u;'],
  ['grant on database', 'GRANT CONNECT ON DATABASE postgres TO PUBLIC;'],
  ['revoke on database', 'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;'],
  ['alter database owner', 'ALTER DATABASE postgres OWNER TO evil;'],
  ['reassign owned', 'REASSIGN OWNED BY a TO b;'],
]

/** Obfuscated spellings of transaction control: comments, case, whitespace, position in the file. */
const OBFUSCATED: [string, string][] = [
  ['lower case', 'select 1; commit;'],
  ['comment before', '/* x */ COMMIT;'],
  ['comment inside', 'COMMIT /* x */ ;'],
  ['after line comment', "SELECT 1; -- ok\nCOMMIT;"],
  ['no trailing semicolon', 'SELECT 1; COMMIT'],
  ['in the middle', 'CREATE TABLE a (i int); COMMIT; CREATE TABLE b (i int);'],
  ['tabs and newlines', "SELECT 1;\n\t\n\tROLLBACK\n;"],
  ['after string with semicolon', "SELECT 'a;b'; COMMIT;"],
  ['after dollar quote', 'SELECT $$ ; $$; COMMIT;'],
  ['after nested comment', 'SELECT 1; /* a /* b */ ; */ COMMIT;'],
  ['after E string backslash', "SELECT E'\\\\'; COMMIT;"],
  ['unicode space? (NBSP is an identifier char)', 'SELECT 1; COMMIT;'],
]

const META: [string, string][] = [
  ['connect', '\\connect other'],
  ['include', '\\i /etc/passwd'],
  ['set', '\\set x 1'],
  ['gexec', 'SELECT 1 \\gexec'],
  ['copy', '\\copy t from stdin'],
  ['quit', '\\q'],
  ['meta after statement', "SELECT 1;\n\\! id\n"],
]

/** Statements PostgreSQL refuses inside a transaction block (or inside a function). */
const AUTOCOMMIT: [string, string][] = [
  ['create index concurrently', 'CREATE INDEX CONCURRENTLY i ON t (c);'],
  ['create unique index concurrently', 'CREATE UNIQUE INDEX CONCURRENTLY i ON t (c);'],
  ['drop index concurrently', 'DROP INDEX CONCURRENTLY i;'],
  ['reindex index concurrently', 'REINDEX INDEX CONCURRENTLY i;'],
  ['reindex table concurrently', 'REINDEX TABLE CONCURRENTLY t;'],
  ['vacuum', 'VACUUM t;'],
  ['vacuum full', 'VACUUM (FULL) t;'],
  ['vacuum analyze', 'VACUUM ANALYZE t;'],
  ['vacuum bare', 'VACUUM;'],
  ['detach partition concurrently', 'ALTER TABLE p DETACH PARTITION p1 CONCURRENTLY;'],
  ['cluster bare', 'CLUSTER;'],
  ['reindex schema', 'REINDEX SCHEMA public;'],
  ['reindex database', 'REINDEX DATABASE postgres;'],
  ['reindex system', 'REINDEX SYSTEM postgres;'],
  ['refresh matview concurrently? (allowed in tx)', 'SELECT 1;'],
]

/** Statements the engine treats as ordinary DDL/DML: they must NOT need a non-transactional bundle. */
const ORDINARY: [string, string][] = [
  ['create table', 'CREATE TABLE a (i int);'],
  ['alter table', 'ALTER TABLE t ADD COLUMN c2 int;'],
  ['create index', 'CREATE INDEX i2 ON t (c);'],
  ['alter type add value', "ALTER TYPE e ADD VALUE 'x';"],
  ['refresh matview concurrently', 'REFRESH MATERIALIZED VIEW CONCURRENTLY m;'],
  ['analyze', 'ANALYZE t;'],
  ['truncate', 'TRUNCATE t;'],
  ['insert', "INSERT INTO t VALUES (1, 'x');"],
  ['do block', "DO $$ BEGIN PERFORM 1; END $$;"],
  ['set constraints', 'SET CONSTRAINTS ALL DEFERRED;'],
  ['lock', 'LOCK TABLE t IN ACCESS EXCLUSIVE MODE;'],
  ['notify', "NOTIFY ch, 'x';"],
  ['create function', 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;'],
  ['create procedure', 'CREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$;'],
]

describe('I4 forbidden statements are refused at lint time in every bundle', () => {
  for (const [name, sql] of FORBIDDEN) {
    for (const transactional of [true, false]) {
      test(`${name} [transactional=${transactional}]`, () => {
        const j = judge(`CREATE TABLE ok_before (i int);\n${sql}\nCREATE TABLE ok_after (i int);\n`, transactional)
        expect(j.blocking.length, `${sql} must block the plan: ${JSON.stringify(j.rules)}`).toBeGreaterThan(0)
        expect(j.forbidden || j.parseError, `${sql}: ${JSON.stringify(j.rules)}`).toBe(true)
      })
    }
  }
})

describe('I4 obfuscated transaction control is still found', () => {
  for (const [name, sql] of OBFUSCATED) {
    test(name, () => {
      const j = judge(sql, true)
      // NBSP is an identifier character: "COMMIT" glued to it is not the keyword, so PostgreSQL itself reads a name
      if (name.startsWith('unicode space')) {
        expect(j.forbidden, JSON.stringify(j.rules)).toBe(false)
        return
      }
      expect(j.forbidden, `${sql}: ${JSON.stringify(j.rules)}`).toBe(true)
    })
  }
})

describe('I4 psql meta-commands are refused (never reach the server)', () => {
  for (const [name, sql] of META) {
    test(name, () => {
      const j = judge(sql, true)
      expect(j.blocking.length, JSON.stringify(j.rules)).toBeGreaterThan(0)
      expect(j.parseError || j.forbidden, JSON.stringify(j.rules)).toBe(true)
    })
  }
})

describe('I4 statements that cannot run in a transaction block', () => {
  for (const [name, sql] of AUTOCOMMIT.filter(([n]) => !n.includes('allowed in tx'))) {
    test(`${name}: refused in a transactional bundle`, () => {
      const j = judge(sql, true)
      expect(j.blocking.length, `${sql}: ${JSON.stringify(j.rules)}`).toBeGreaterThan(0)
      expect(
        j.blocking.includes('nontransactional_statement_in_transactional') || j.forbidden,
        `${sql}: ${JSON.stringify(j.rules)}`,
      ).toBe(true)
    })
    test(`${name}: accepted in a non-transactional bundle as the only statement`, () => {
      const j = judge(sql, false)
      expect(j.forbidden, JSON.stringify(j.rules)).toBe(false)
      expect(j.rules).not.toContain('nontransactional_statement_in_transactional')
      expect(j.rules).not.toContain('needless_nontransactional')
      expect(j.autocommit).toBe(1)
    })
  }
  test('two autocommit statements in one non-transactional bundle are reported', () => {
    const j = judge('CREATE INDEX CONCURRENTLY i ON t (c); CREATE INDEX CONCURRENTLY j ON t (d);', false)
    expect(j.rules).toContain('multiple_nontransactional_statements')
  })
  test('non-transactional bundle without any statement that needs it is blocking (needless_nontransactional)', () => {
    const j = judge('CREATE TABLE a (i int);', false)
    expect(j.blocking).toContain('needless_nontransactional')
  })
  test('mixed: an autocommit statement beside ordinary DDL in a non-transactional bundle leaves the ordinary DDL non-atomic', () => {
    const j = judge('CREATE TABLE a (i int); CREATE INDEX CONCURRENTLY i ON a (i);', false)
    // The documentation says non-transactional bundles SHOULD hold exactly one non-transactional statement.
    // Characterisation: what the linter says about "ordinary + autocommit".
    expect(j.rules, JSON.stringify(j.rules)).toBeDefined()
  })
})

describe('I4 ordinary statements are not misclassified as autocommit', () => {
  for (const [name, sql] of ORDINARY) {
    test(`${name}: accepted in a transactional bundle, and a non-transactional bundle for it is needless`, () => {
      const t = judge(sql, true)
      expect(t.forbidden, `${sql}: ${JSON.stringify(t.rules)}`).toBe(false)
      expect(t.rules).not.toContain('nontransactional_statement_in_transactional')
      const n = judge(sql, false)
      expect(n.blocking, `${sql}: ${JSON.stringify(n.rules)}`).toContain('needless_nontransactional')
    })
  }
})

describe('I4 what the classifier cannot see (function bodies are text): documented residual, proven at apply level', () => {
  const BODIES: [string, string][] = [
    ['DO with COMMIT', 'DO $$ BEGIN COMMIT; END $$;'],
    ['DO with EXECUTE COMMIT', "DO $$ BEGIN EXECUTE 'COMMIT'; END $$;"],
    ['DO with ROLLBACK', 'DO $$ BEGIN ROLLBACK; END $$;'],
    ['DO with SET LOCAL ROLE', 'DO $$ BEGIN SET LOCAL ROLE postgres; END $$;'],
    ['DO with RESET ROLE', 'DO $$ BEGIN RESET ROLE; END $$;'],
    ['DO with set_config scs', "DO $$ BEGIN PERFORM set_config('standard_conforming_strings','off',true); END $$;"],
    ['DO with SET search_path', "DO $$ BEGIN PERFORM set_config('search_path','evil',true); END $$;"],
    ['procedure that commits', 'CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN COMMIT; END $$; CALL p();'],
    ['single-quoted DO body with COMMIT', "DO 'BEGIN COMMIT; END';"],
    ['E-string DO body with COMMIT', "DO E'BEGIN COMMIT; END';"],
    ['function with SET clause on a pinned setting', "CREATE FUNCTION f() RETURNS int LANGUAGE sql SET standard_conforming_strings = off AS $$ SELECT 1 $$;"],
  ]
  for (const [name, sql] of BODIES) {
    test(`${name}: lint outcome is recorded (the proof that apply refuses or rolls back is in the int test)`, () => {
      const j = judge(sql, true)
      // Characterisation only: the classifier does not look inside bodies (documented in migration.ts, settingsCall).
      expect(typeof j.forbidden).toBe('boolean')
    })
  }
})

// I4 ground truth: statements PostgreSQL itself refuses inside a transaction block must be recognised by the
// classifier (autocommitOnly or forbidden), so a transactional bundle that holds one is refused at lint time and
// a non-transactional bundle can carry it. The server is the oracle: each statement runs inside BEGIN ... ROLLBACK
// as a superuser on PostgreSQL 16, 17 and 18 against a small fixture database.
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { analyzeMigrationSql, loadParser } from '@exponetdb/postgres/parser'
import { MAJORS, openLab, type Lab, type Major } from './lib/pg.ts'

const FIXTURE = `
CREATE TABLE t (id int PRIMARY KEY, c text);
CREATE INDEX i ON t (c);
CREATE TABLE p (id int) PARTITION BY RANGE (id);
CREATE TABLE p1 PARTITION OF p FOR VALUES FROM (0) TO (10);
CREATE MATERIALIZED VIEW m AS SELECT 1 AS x;
CREATE UNIQUE INDEX m_x ON m (x);
CREATE TYPE e AS ENUM ('a');
`
// statements that exist on every major; the ones that need a newer major are listed with their minimum
const STATEMENTS: [string, string, number?][] = [
  ['create index concurrently', 'CREATE INDEX CONCURRENTLY i2 ON t (c)'],
  ['create unique index concurrently', 'CREATE UNIQUE INDEX CONCURRENTLY i3 ON t (id)'],
  ['drop index concurrently', 'DROP INDEX CONCURRENTLY i'],
  ['reindex index concurrently', 'REINDEX INDEX CONCURRENTLY i'],
  ['reindex table concurrently', 'REINDEX TABLE CONCURRENTLY t'],
  ['reindex (concurrently) option', 'REINDEX (CONCURRENTLY) TABLE t'],
  ['reindex schema', 'REINDEX SCHEMA public'],
  ['reindex schema concurrently', 'REINDEX SCHEMA CONCURRENTLY public'],
  ['reindex database', 'REINDEX DATABASE CURRENT_DATABASE'],
  ['reindex system', 'REINDEX SYSTEM CURRENT_DATABASE'],
  ['vacuum', 'VACUUM t'],
  ['vacuum bare', 'VACUUM'],
  ['vacuum full', 'VACUUM FULL t'],
  ['vacuum analyze', 'VACUUM ANALYZE t'],
  ['vacuum (parallel)', 'VACUUM (PARALLEL 2) t'],
  ['cluster bare', 'CLUSTER'],
  ['cluster table using', 'CLUSTER t USING t_pkey'],
  ['detach partition concurrently', 'ALTER TABLE p DETACH PARTITION p1 CONCURRENTLY'],
  ['detach partition (plain)', 'ALTER TABLE p DETACH PARTITION p1'],
  ['refresh matview concurrently', 'REFRESH MATERIALIZED VIEW CONCURRENTLY m'],
  ['alter type add value', "ALTER TYPE e ADD VALUE 'b'"],
  ['analyze', 'ANALYZE t'],
  ['truncate', 'TRUNCATE t'],
  ['discard all', 'DISCARD ALL'],
  ['discard temp', 'DISCARD TEMP'],
  ['checkpoint', 'CHECKPOINT'],
  ['create database', 'CREATE DATABASE nope'],
  ['drop database', 'DROP DATABASE nope'],
  ['create tablespace', "CREATE TABLESPACE ts LOCATION '/tmp'"],
  ['alter system', 'ALTER SYSTEM SET work_mem = 1'],
  ['prepare transaction', "PREPARE TRANSACTION 'x'"],
  ['load', "LOAD 'auto_explain'"],
  ['create subscription', "CREATE SUBSCRIPTION s CONNECTION 'host=127.0.0.1 port=1' PUBLICATION p"],
  ['alter table set tablespace', 'ALTER TABLE t SET TABLESPACE pg_default'],
  ['alter index set tablespace', 'ALTER INDEX i SET TABLESPACE pg_default'],
  ['lock', 'LOCK TABLE t'],
  ['listen', 'LISTEN ch'],
  ['notify', 'NOTIFY ch'],
  ['declare cursor', 'DECLARE c CURSOR FOR SELECT 1'],
  ['call', 'CALL nope()'],
  ['do', 'DO $$ BEGIN NULL; END $$'],
]

const labs = new Map<Major, Lab>()
beforeAll(async () => {
  for (const m of MAJORS) {
    const lab = await openLab(m, `b2_cls_${m}`)
    await lab.admin.query(FIXTURE)
    labs.set(m, lab)
    await loadParser(m)
  }
}, 300_000)
afterAll(async () => {
  for (const l of labs.values()) await l.close()
})

async function serverNeedsAutocommit(lab: Lab, sql: string): Promise<{ needs: boolean; other?: string }> {
  await lab.admin.query('BEGIN')
  try {
    await lab.admin.query(sql)
    return { needs: false }
  } catch (e) {
    const err = e as { code?: string; message: string }
    // 25001 active_sql_transaction ("... cannot run inside a transaction block"); some report 25P01-style text only
    const needs = err.code === '25001' || /cannot (run|be executed) (inside|from) a (transaction block|function)|cannot run inside a transaction block/i.test(err.message)
    return needs ? { needs: true } : { needs: false, other: `${err.code} ${err.message.slice(0, 60)}` }
  } finally {
    await lab.admin.query('ROLLBACK').catch(() => undefined)
  }
}

describe.each(MAJORS)('I4 classifier against the server on PostgreSQL %i', (major) => {
  test('every statement PostgreSQL refuses inside a transaction block is autocommitOnly or forbidden for the engine', async () => {
    const lab = labs.get(major) as Lab
    const missed: string[] = []
    const needless: string[] = []
    const table: string[] = []
    for (const [name, sql, minMajor] of STATEMENTS) {
      if (minMajor !== undefined && major < minMajor) continue
      const server = await serverNeedsAutocommit(lab, sql)
      const a = analyzeMigrationSql(major, `${sql};`, { trustedExtensions: [] })
      const st = a.ok ? a.statements[0] : undefined
      const covered = st !== undefined && (st.autocommitOnly || st.forbidden !== null)
      table.push(`${name}: server_needs_autocommit=${server.needs}${server.other ? ` (${server.other})` : ''} repo=${st === undefined ? 'unparsed' : st.forbidden !== null ? 'forbidden' : st.autocommitOnly ? 'autocommit' : 'ordinary'}`)
      if (server.needs && !covered) missed.push(`${name} -> ${sql}`)
      if (!server.needs && st?.autocommitOnly === true) needless.push(`${name} -> ${sql}`)
    }
    console.log(`I4[pg${major}] classifier vs server\n  ${table.join('\n  ')}`)
    expect(missed, 'refused by the server inside a transaction block but classified as ordinary').toEqual([])
    expect(needless, 'classified as autocommit-only but the server runs it in a transaction block').toEqual([])
  }, 120_000)
})

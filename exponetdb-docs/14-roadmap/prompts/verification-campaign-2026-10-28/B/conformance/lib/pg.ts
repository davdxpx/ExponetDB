// PostgreSQL helpers for the conformance tests: superuser clients of the disposable servers
// (EXDB_TEST_TARGETS), the engine's own way of sending a statement (extended protocol, one message each),
// and pg_stat_statements as an oracle for the server's own statement boundaries.
import type pg from 'pg'
import { createDatabase, dropDatabase, serverFor, superuserClient, type TestServer } from '@exponetdb/testkit'

export type Major = 16 | 17 | 18
export const MAJORS: readonly Major[] = [16, 17, 18]

export interface Lab {
  readonly major: Major
  readonly server: TestServer
  readonly database: string
  readonly admin: pg.Client
  readonly observer: pg.Client
  close(): Promise<void>
}

/** A disposable database with pg_stat_statements on each major; `label` names it. */
export async function openLab(major: Major, label: string): Promise<Lab> {
  const server = serverFor(major)
  const database = await createDatabase(server, label)
  const admin = await superuserClient(server, database)
  const observer = await superuserClient(server, database)
  await admin.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements')
  return {
    major,
    server,
    database,
    admin,
    observer,
    async close() {
      await admin.end().catch(() => undefined)
      await observer.end().catch(() => undefined)
      await dropDatabase(server, database).catch(() => undefined)
    },
  }
}

export interface RunResult {
  ok: boolean
  /** statements the server reported (command tags), in order */
  tags: string[]
  error?: { code?: string; message: string; position?: string }
}

/** The whole text as ONE simple-protocol message (what a multi-statement string gets from the server). */
export async function runWhole(c: pg.Client, text: string): Promise<RunResult> {
  try {
    const r = (await c.query(text)) as pg.QueryResult | pg.QueryResult[]
    const list = Array.isArray(r) ? r : [r]
    return { ok: true, tags: list.map((x) => String(x.command ?? '')) }
  } catch (e) {
    const err = e as { code?: string; message: string; position?: string }
    return { ok: false, tags: [], error: { ...(err.code ? { code: err.code } : {}), message: err.message, ...(err.position ? { position: err.position } : {}) } }
  }
}

/** Statement by statement the way the engine sends them: extended protocol, inside one transaction. */
export async function runSliced(c: pg.Client, slices: readonly string[]): Promise<RunResult> {
  const tags: string[] = []
  try {
    await c.query('BEGIN')
    for (const text of slices) {
      const r = (await c.query({ text, values: [], queryMode: 'extended' } as never)) as pg.QueryResult
      tags.push(String(r.command ?? ''))
    }
    await c.query('COMMIT')
    return { ok: true, tags }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined)
    const err = e as { code?: string; message: string; position?: string }
    return { ok: false, tags, error: { ...(err.code ? { code: err.code } : {}), message: err.message } }
  }
}

/** Whole text inside one explicit transaction (same atomicity as the sliced run). */
export async function runWholeTx(c: pg.Client, text: string): Promise<RunResult> {
  await c.query('BEGIN')
  const r = await runWhole(c, text)
  await c.query(r.ok ? 'COMMIT' : 'ROLLBACK').catch(() => undefined)
  return r
}

/** pg_stat_statements: reset, run `fn`, return the texts the server recorded (with calls). */
export async function recordedStatements(lab: Lab, fn: () => Promise<void>): Promise<{ query: string; calls: number }[]> {
  await lab.observer.query('SELECT pg_stat_statements_reset()')
  await fn()
  const r = await lab.observer.query(
    `SELECT query, calls::int AS calls FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND query NOT ILIKE '%pg_stat_statements%'
        AND query NOT IN ('BEGIN', 'COMMIT', 'ROLLBACK')`,
  )
  return r.rows as { query: string; calls: number }[]
}

export const sortedTexts = (rows: { query: string; calls: number }[]): string[] =>
  rows.flatMap((r) => Array.from({ length: r.calls }, () => r.query)).sort()

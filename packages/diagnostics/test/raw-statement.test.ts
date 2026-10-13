import { TargetError, TargetRow, type TargetSession, type TrustedSql } from '@exponetdb/postgres'
import { loadParser, redactStatementSync } from '@exponetdb/postgres/parser'
import { beforeAll, describe, expect, it } from 'vitest'
import { findStatement, matchesDigest, STATEMENTS_SCAN } from '../src/index.ts'

/**
 * The live search of the raw statement view (owner decision S2) on a
 * scripted session: the digest is recomputed from every text read, the
 * named session must still run the statement, and the aggregated
 * statistics are searched only when the extension is installed and
 * loaded. The real-PostgreSQL path is in
 * `apps/server/test/http-raw-statement.int.test.ts`; this file covers what
 * the disposable servers cannot (none preloads `pg_stat_statements`).
 */
beforeAll(async () => {
  await loadParser(17)
})

const digest = (text: string) => redactStatementSync(text, { major: 17 }).digest

interface Script {
  readonly activity?: readonly Record<string, unknown>[]
  readonly extension?: string | null
  readonly statements?: readonly Record<string, unknown>[] | TargetError
}

function session(script: Script): { session: TargetSession; seen: string[] } {
  const seen: string[] = []
  const fake = {
    facts: { major: 17 },
    async query(statement: TrustedSql, params: readonly unknown[] = []) {
      const text = statement.text
      if (text.includes('pg_stat_activity')) {
        seen.push(`activity:${JSON.stringify(params)}`)
        const pid = params[0]
        return (script.activity ?? [])
          .filter((r) => pid === null || r['pid'] === String(pid))
          .map((r) => new TargetRow(r))
      }
      if (text.includes('pg_extension')) {
        seen.push('extension')
        return script.extension === undefined || script.extension === null
          ? []
          : [new TargetRow({ nspname: script.extension })]
      }
      if (text.includes('pg_stat_statements')) {
        seen.push(
          `statements:${text.includes('"ext"."pg_stat_statements"') ? 'qualified' : 'plain'}:${JSON.stringify(params)}`,
        )
        if (script.statements instanceof TargetError) throw script.statements
        return (script.statements ?? []).map((r) => new TargetRow(r))
      }
      throw new Error(`unexpected statement: ${text}`)
    },
  }
  return { session: fake as unknown as TargetSession, seen }
}

// Every column arrives as text, as from the driver.
const row = (pid: number, query: string) => ({
  pid: String(pid),
  backend_start: '2026-10-13T10:00:00.000Z',
  query_start: '2026-10-13T10:00:01.000Z',
  query,
})

describe('matchesDigest', () => {
  it('compares the digest of the redacted form, whatever the literals', () => {
    const d = digest(`SELECT * FROM t WHERE email = 'a@example.test'`)
    expect(matchesDigest(`SELECT * FROM t WHERE email = 'b@example.test'`, d, 17)).toBe(true)
    expect(matchesDigest(`SELECT * FROM t WHERE email = $1`, d, 17)).toBe(true)
    expect(matchesDigest(`SELECT * FROM u WHERE email = 'a@example.test'`, d, 17)).toBe(false)
    expect(matchesDigest(`SELECT 1`, `sha256:${'0'.repeat(64)}`, 17)).toBe(false)
  })
})

describe('findStatement', () => {
  const a = `SELECT 'first' AS v`
  const b = `UPDATE t SET n = 2 WHERE id = 7`

  it('finds the first session whose statement has the digest', async () => {
    const { session: s, seen } = session({ activity: [row(11, a), row(12, b), row(13, b)] })
    const found = await findStatement(s, { digest: digest(`UPDATE t SET n = 5 WHERE id = 1`) })
    expect(found).toEqual({
      text: b,
      origin: {
        view: 'pg_stat_activity',
        pid: 12,
        backendStart: '2026-10-13T10:00:00.000Z',
        queryStart: '2026-10-13T10:00:01.000Z',
      },
    })
    expect(seen).toEqual(['activity:[null,1000]'])
  })

  it('looks only at a named session: gone, restarted or moved on', async () => {
    const script = { activity: [row(11, a)], extension: 'ext' }
    expect(
      await findStatement(session(script).session, {
        digest: digest(a),
        session: { pid: 11, backendStart: '2026-10-13T10:00:00.000Z' },
      }),
    ).toMatchObject({ text: a })
    expect(
      await findStatement(session(script).session, {
        digest: digest(a),
        session: { pid: 99, backendStart: undefined },
      }),
    ).toEqual({ missing: 'not_held' })
    expect(
      await findStatement(session(script).session, {
        digest: digest(a),
        session: { pid: 11, backendStart: '2026-10-13T09:00:00.000Z' },
      }),
    ).toEqual({ missing: 'not_held' })
    const moved = session(script)
    expect(
      await findStatement(moved.session, {
        digest: digest(b),
        session: { pid: 11, backendStart: undefined },
      }),
    ).toEqual({ missing: 'digest_mismatch' })
    // A named session is never looked up in the aggregated statistics.
    expect(moved.seen).toEqual(['activity:[11,1000]'])
  })

  it('searches pg_stat_statements in its schema when no session holds it', async () => {
    const normalized = 'SELECT * FROM t WHERE id = $1'
    const { session: s, seen } = session({
      activity: [row(11, a)],
      extension: 'ext',
      statements: [
        { query: 'SELECT $1', calls: '9', total_ms: '1.5', mean_ms: '0.1', rows: '9' },
        { query: null, calls: '1', total_ms: '0', mean_ms: '0', rows: '0' },
        { query: normalized, calls: '42', total_ms: '84.5', mean_ms: '2.0119', rows: '40' },
      ],
    })
    const found = await findStatement(s, { digest: digest('SELECT * FROM t WHERE id = 5') })
    expect(found).toEqual({
      text: normalized,
      origin: {
        view: 'pg_stat_statements',
        calls: 42,
        totalExecTimeMs: 84.5,
        meanExecTimeMs: 2.0119,
        rows: 40,
      },
    })
    expect(seen).toEqual([
      'activity:[null,1000]',
      'extension',
      `statements:qualified:[${STATEMENTS_SCAN}]`,
    ])
  })

  it('says why it found nothing: not installed, installed but not loaded, not held', async () => {
    const unknown = `sha256:${'0'.repeat(64)}`
    expect(
      await findStatement(session({ activity: [row(11, a)] }).session, { digest: unknown }),
    ).toEqual({
      missing: 'extension_missing',
    })
    const notLoaded = new TargetError('TARGET_SQL_ERROR', 'server_error', { sqlstate: '55000' })
    expect(
      await findStatement(
        session({ activity: [], extension: 'ext', statements: notLoaded }).session,
        { digest: unknown },
      ),
    ).toEqual({ missing: 'extension_missing' })
    expect(
      await findStatement(session({ activity: [], extension: 'ext', statements: [] }).session, {
        digest: unknown,
      }),
    ).toEqual({ missing: 'not_held' })
    // Any other failure of the statistics read is not hidden as an absent statement.
    const denied = new TargetError('PERMISSION_DENIED', 'insufficient_privilege', {
      sqlstate: '42501',
    })
    await expect(
      findStatement(session({ activity: [], extension: 'ext', statements: denied }).session, {
        digest: unknown,
      }),
    ).rejects.toBe(denied)
  })
})

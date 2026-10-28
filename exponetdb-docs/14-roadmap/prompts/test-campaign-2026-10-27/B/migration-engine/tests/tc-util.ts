import { appendFileSync, mkdirSync } from 'node:fs'
import {
  readLedgerRows,
  readMigrationEvents,
  readVerifications,
} from '@exponetdb/postgres'
import { serverFor, superuserClient, type TestServer } from '@exponetdb/testkit'
import { operationError } from '../../registry/test/harness.ts'
import type { Target, World } from './tc-world.ts'

/** Throwaway campaign helpers: every observation is appended to <EVID>/<group>.jsonl. */
export const EVID = process.env['TC_EVID'] ?? '/tmp/tc-mig-evidence'
mkdirSync(EVID, { recursive: true })
export const PG: 16 | 17 | 18 = (Number(process.env['TC_PG'] ?? '18') as 16 | 17 | 18)
export const server: TestServer = serverFor(PG)

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

export function rec(group: string, id: string, verdict: string, data: unknown = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), id, verdict, data }, replacer)
  appendFileSync(`${EVID}/${group}.jsonl`, `${line}\n`)
  console.log(`[tc:${group}] ${id} ${verdict} ${line.length > 1500 ? `${line.slice(0, 1500)}...` : line}`)
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type Attempt<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; details: unknown; message: string; name: string }

export async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    const x = e as { code?: unknown; details?: unknown; message?: string; name?: string }
    return {
      ok: false,
      code: String(x.code ?? 'NO_CODE'),
      details: x.details,
      message: String(x.message ?? e).slice(0, 300),
      name: String(x.name ?? 'Error'),
    }
  }
}

export async function su<T>(
  t: Target,
  fn: (c: Awaited<ReturnType<typeof superuserClient>>) => Promise<T>,
): Promise<T> {
  const c = await superuserClient(server, t.database)
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

async function observer<T>(
  w: World,
  t: Target,
  fn: (s: Awaited<ReturnType<World['h']['workerConnector']['forTarget']>>['session']) => Promise<T>,
): Promise<T> {
  const opened = await w.h.workerConnector.forTarget(t.record, 'observer', 'tc')
  try {
    return await fn(opened.session)
  } finally {
    await opened.session.close()
  }
}

export const ledgerOf = (w: World, t: Target) =>
  observer(w, t, (s) => s.readOnly((tx) => readLedgerRows(tx)))
export const verifsOf = (w: World, t: Target, id: string) =>
  observer(w, t, (s) => s.readOnly((tx) => readVerifications(tx, id)))
export const eventsOf = (w: World, t: Target, id: string) =>
  observer(w, t, (s) => s.readOnly((tx) => readMigrationEvents(tx, { migrationId: id })))

export async function opSteps(w: World, operationId: string): Promise<string[]> {
  const r = await w.h.worker.query(
    'tc.steps',
    `SELECT kind, detail->>'step' AS step FROM operations.operation_events
      WHERE operation_id = $1 ORDER BY event_id`,
    [operationId],
  )
  return r.rows.map((x) => `${x.text('kind')}:${x.textOrNull('step') ?? ''}`)
}

export async function opCode(w: World, operationId: string): Promise<string | null> {
  return (await operationError(w.h, operationId)).code
}

export async function opLocks(w: World, operationId: string): Promise<number> {
  const r = await w.h.worker.query(
    'tc.oplocks',
    'SELECT count(*)::int AS n FROM operations.operation_locks WHERE operation_id = $1',
    [operationId],
  )
  return r.rows[0]?.int('n') ?? -1
}

export async function hasRelation(t: Target, name: string): Promise<boolean> {
  return su(t, async (c) => {
    const r = await c.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name])
    return r.rows[0].ok === true
  })
}

/** Advisory locks of key1 `EXDB` held on the target's database. */
export async function exdbAdvisoryLocks(t: Target): Promise<{ pid: number; objid: number; mode: string }[]> {
  return su(t, async (c) => {
    const r = await c.query(
      `SELECT l.pid, l.objid::bigint AS objid, l.mode FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.classid = 1163412546 AND l.granted
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    )
    return r.rows.map((x) => ({ pid: x.pid, objid: Number(x.objid), mode: x.mode }))
  })
}

/** Changes the target's append-only ledger as its superuser, past the guard triggers. */
export async function tamper(t: Target, statement: string, params: unknown[] = []) {
  await su(t, async (c) => {
    await c.query('BEGIN')
    await c.query('SET LOCAL session_replication_role = replica')
    await c.query(statement, params)
    await c.query('COMMIT')
  })
}

export function planRules(p: { body: Record<string, unknown> }): { id: string; result: string }[] {
  const policy = p.body['policy'] as { rules?: { id: string; result: string }[] } | undefined
  return policy?.rules ?? []
}
export function planFacts(p: { body: Record<string, unknown> }): Record<string, unknown> {
  return ((p.body['content'] as { facts?: Record<string, unknown> })?.facts ?? {}) as Record<string, unknown>
}

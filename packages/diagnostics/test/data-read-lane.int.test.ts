import type { ControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId } from '@exponetdb/kernel'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  awaitDataRead,
  cancelDataRead,
  type DataReadOutcome,
  type DataReadRequest,
  type DataReadSubmission,
  DataReadWorker,
  DiagnosticsError,
  submitDataRead,
} from '../src/index.ts'

/**
 * The data-read lane (ADR-0028 §1, §2) against a real Control Store: the
 * round trip, ciphertext only at rest, the concurrency bounds, a cancel
 * that reaches only the owner's read, a dead worker, tampering and the
 * cleanup. The executor is a stand-in here; data-read.int.test.ts runs the
 * real one against PostgreSQL 16, 17 and 18.
 */
const CANARY = 'canary-7f3a-row-value'

let db: MigratedTestDatabase
let serve: ControlStore
let worker: ControlStore
const workers: DataReadWorker[] = []

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_lane')
  serve = db.store('exdb_serve')
  worker = db.store('exdb_worker')
}, 120_000)

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()))
  await db.asSuperuser((c) => c.query('DELETE FROM dataread.reads; DELETE FROM dataread.workers'))
})

afterAll(async () => {
  await db?.drop()
})

const OWNER = {
  identityId: newId('idn', Date.now()),
  clientId: newId('cli', Date.now()),
  grantId: newId('grt', Date.now()),
}

function request(overrides: Partial<DataReadRequest> = {}): DataReadRequest {
  return {
    kind: 'query',
    sql: `SELECT '${CANARY}' AS v`,
    params: [CANARY],
    callerClass: 'agent',
    maxRows: 100,
    maxBytes: 1024 * 1024,
    statementTimeoutMs: 5_000,
    analyze: false,
    sensitiveColumns: [],
    requestId: newId('req', Date.now()),
    ...overrides,
  }
}

function submission(overrides: Partial<DataReadSubmission> = {}): DataReadSubmission {
  return {
    ...OWNER,
    queryId: newId('qry', Date.now()),
    targetId: newId('tgt', 0),
    callerClass: 'agent',
    request: request(),
    timeoutMs: 10_000,
    ...overrides,
  }
}

const ROWS: DataReadOutcome = {
  kind: 'query',
  columns: [{ name: 'v', type: 'text', masked: false }],
  rows: [[CANARY]],
  rowCount: 1,
  truncated: false,
  truncation: null,
  rlsRelations: [],
  durationMs: 1,
}

type Execute = ConstructorParameters<typeof DataReadWorker>[0]['execute']

async function startWorker(execute: Execute, workerId = newId('prc', Date.now())) {
  const w = new DataReadWorker({ store: worker, workerId, execute, pollMs: 20 })
  workers.push(w)
  await w.start()
  return w
}

/** A worker driven by the test, one round at a time. */
async function manualWorker(execute: Execute, workerId = newId('prc', Date.now())) {
  const w = new DataReadWorker({ store: worker, workerId, execute })
  workers.push(w)
  await w.start({ loop: false })
  return w
}

/** Waits until the worker has written back every read it claimed. */
async function settle(w: DataReadWorker): Promise<void> {
  const end = Date.now() + 5_000
  while (w.inFlight > 0) {
    if (Date.now() > end) throw new Error('the worker did not settle')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Resolves once `predicate` holds, polling the Control Store as the superuser. */
async function until(sql: string, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const { rows } = await db.asSuperuser((c) => c.query<{ ok: boolean }>(sql))
    if (rows[0]?.ok === true) return
    if (Date.now() > end) throw new Error(`timed out: ${sql}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (error) {
    if (error instanceof DiagnosticsError) return error.code
    throw error
  }
  return 'resolved'
}

describe('the data-read lane', () => {
  it('carries a read to the worker and the result back, and deletes the row', async () => {
    const seen: DataReadRequest[] = []
    await startWorker(async (_target, read) => {
      seen.push(read)
      return ROWS
    })
    const s = submission()
    const ticket = await submitDataRead(serve, s)
    const outcome = await awaitDataRead(serve, ticket)
    expect(outcome).toEqual(ROWS)
    expect(seen).toEqual([s.request])
    const { rows } = await db.asSuperuser((c) => c.query('SELECT 1 FROM dataread.reads'))
    expect(rows).toHaveLength(0)
  })

  it('stores ciphertext only: neither the statement nor a value is readable in the Control Store', async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((r) => {
      release = r
    })
    await startWorker(async () => {
      await held
      return ROWS
    })
    const ticket = await submitDataRead(serve, submission())
    // Request at rest, then result at rest (the worker has written, serve not yet collected).
    const request = await db.asSuperuser((c) =>
      c.query<{ request: Buffer }>('SELECT request FROM dataread.reads'),
    )
    expect(request.rows[0]?.request.includes(CANARY)).toBe(false)
    expect(request.rows[0]?.request.includes('SELECT')).toBe(false)
    release?.()
    await until(`SELECT bool_and(state = 'done') AS ok FROM dataread.reads`)
    const result = await db.asSuperuser((c) =>
      c.query<{ result: Buffer }>('SELECT result FROM dataread.reads'),
    )
    expect(result.rows[0]?.result.includes(CANARY)).toBe(false)
    expect(await awaitDataRead(serve, ticket)).toEqual(ROWS)
  })

  it('refuses without a live worker: CAPABILITY_UNAVAILABLE, never an empty result', async () => {
    expect(await code(submitDataRead(serve, submission()))).toBe('CAPABILITY_UNAVAILABLE')
  })

  it('bounds concurrent reads per grant, per target and per installation (RATE_LIMITED, Retry-After)', async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((r) => {
      release = r
    })
    await startWorker(async () => {
      await held
      return ROWS
    })
    const target = newId('tgt', 1)
    const tickets = [
      await submitDataRead(serve, submission({ targetId: target })),
      await submitDataRead(serve, submission({ targetId: target })),
    ]
    let refusal: unknown
    try {
      await submitDataRead(serve, submission({ targetId: target }))
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(DiagnosticsError)
    expect(refusal).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 2 })
    // Another agent's grant on the same target: agents hold at most 2 of its 3 reads
    // (owner decision 2026-10-13), the third is kept for a person.
    const other = { grantId: newId('grt', 2), clientId: newId('cli', 2) }
    expect(await code(submitDataRead(serve, submission({ ...other, targetId: target })))).toBe(
      'RATE_LIMITED',
    )
    const person = (n: number) =>
      submission({
        identityId: newId('idn', 100 + n),
        clientId: null,
        grantId: null,
        callerClass: 'human',
        targetId: target,
      })
    tickets.push(await submitDataRead(serve, person(1)))
    // The target's bound (3) holds for people too.
    expect(await code(submitDataRead(serve, person(2)))).toBe('RATE_LIMITED')
    // Installation bound: 8 open reads in all.
    const unbounded = { owner: 100, target: 100, agentTarget: 100 }
    const small = { ...unbounded, installation: 4, agentInstallation: 100 }
    tickets.push(await submitDataRead(serve, submission({ grantId: newId('grt', 3) }), small))
    expect(await code(submitDataRead(serve, submission({ grantId: newId('grt', 4) }), small))).toBe(
      'RATE_LIMITED',
    )
    // Agents hold at most 6 of the installation's 8 (here: 3 of 5, with 3 agent reads open).
    const fewAgents = { ...unbounded, installation: 5, agentInstallation: 3 }
    expect(
      await code(submitDataRead(serve, submission({ grantId: newId('grt', 5) }), fewAgents)),
    ).toBe('RATE_LIMITED')
    tickets.push(
      await submitDataRead(serve, { ...person(3), targetId: newId('tgt', 9) }, fewAgents),
    )
    release?.()
    for (const t of tickets) expect(await awaitDataRead(serve, t)).toEqual(ROWS)
  })

  it('refuses a queryId that was used already', async () => {
    await startWorker(async () => ROWS)
    const s = submission()
    const ticket = await submitDataRead(serve, s)
    expect(await code(submitDataRead(serve, { ...s, request: request() }))).toBe(
      'VALIDATION_FAILED',
    )
    await awaitDataRead(serve, ticket)
  })

  it('cancels exactly the owner read: another identity, client or grant reaches nothing', async () => {
    const aborted: string[] = []
    await startWorker(async (_t, read, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      aborted.push(read.requestId)
      return { kind: 'refused', code: 'QUERY_CANCELED' }
    })
    const s = submission()
    const ticket = await submitDataRead(serve, s)
    await until(`SELECT bool_and(state = 'running') AS ok FROM dataread.reads`)
    const stranger = { ...OWNER, identityId: newId('idn', 9) }
    expect(await cancelDataRead(serve, stranger, s.targetId, s.queryId)).toBe('finished')
    expect(
      await cancelDataRead(serve, { ...OWNER, grantId: newId('grt', 9) }, s.targetId, s.queryId),
    ).toBe('finished')
    expect(await cancelDataRead(serve, OWNER, newId('tgt', 9), s.queryId)).toBe('finished')
    expect(aborted).toEqual([])
    expect(await cancelDataRead(serve, OWNER, s.targetId, s.queryId)).toBe('canceled')
    expect(await code(awaitDataRead(serve, ticket))).toBe('QUERY_CANCELED')
    expect(aborted).toEqual([s.request.requestId])
    // Ended: a second cancel finds nothing of the owner's running.
    expect(await cancelDataRead(serve, OWNER, s.targetId, s.queryId)).toBe('finished')
  })

  it('a closed stream (the caller signal) cancels the running read', async () => {
    let started: (() => void) | undefined
    const running = new Promise<void>((r) => {
      started = r
    })
    let stopped = false
    await startWorker(async (_t, _read, signal) => {
      started?.()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      stopped = true
      return { kind: 'refused', code: 'QUERY_CANCELED' }
    })
    const controller = new AbortController()
    const ticket = await submitDataRead(serve, submission())
    const waiting = awaitDataRead(serve, ticket, { signal: controller.signal })
    await running
    controller.abort()
    expect(await code(waiting)).toBe('QUERY_CANCELED')
    await until(`SELECT count(*) = 0 OR bool_and(state = 'canceled') AS ok FROM dataread.reads`)
    expect(stopped).toBe(true)
  })

  it('reports a read past its deadline as QUERY_TIMEOUT and stops it on the worker', async () => {
    let stopped = false
    await startWorker(async (_t, _read, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      stopped = true
      return { kind: 'refused', code: 'QUERY_CANCELED' }
    })
    const ticket = await submitDataRead(serve, submission({ timeoutMs: 1_000 }))
    expect(await code(awaitDataRead(serve, ticket))).toBe('QUERY_TIMEOUT')
    await until(`SELECT count(*) = 0 OR bool_and(state = 'canceled') AS ok FROM dataread.reads`)
    expect(stopped).toBe(true)
  })

  it('a worker that stops beating leaves no read waiting forever: CAPABILITY_UNAVAILABLE', async () => {
    await startWorker(async () => ROWS)
    const s = submission()
    // The worker's heartbeat goes stale before it claims (as after a crash).
    await db.asSuperuser((c) =>
      c.query(`UPDATE dataread.workers SET heartbeat_at = clock_timestamp() - interval '1 minute'`),
    )
    expect(await code(submitDataRead(serve, s))).toBe('CAPABILITY_UNAVAILABLE')
  })

  it('a worker restart is a new key: a read sealed to the old one is never opened', async () => {
    let calls = 0
    const execute: Execute = async () => {
      calls++
      return ROWS
    }
    const workerId = newId('prc', Date.now())
    const old = await manualWorker(execute, workerId)
    const first = await submitDataRead(serve, submission())
    const second = await submitDataRead(serve, submission())
    await old.stop()
    // A restart is a new process: the reads addressed to the old one have no live worker.
    expect(await code(awaitDataRead(serve, first))).toBe('CAPABILITY_UNAVAILABLE')
    // Even the same worker id with a new key (never in production) cannot open them.
    const again = await manualWorker(execute, workerId)
    await again.round()
    await settle(again)
    expect(await code(awaitDataRead(serve, second))).toBe('INTERNAL')
    expect(calls).toBe(0)
  })

  it('refuses a request whose binding was changed at rest (another target): nothing runs', async () => {
    let calls = 0
    const w = await manualWorker(async () => {
      calls++
      return ROWS
    })
    const ticket = await submitDataRead(serve, submission())
    await db.asSuperuser((c) =>
      c.query('UPDATE dataread.reads SET target_id = $1 WHERE query_id = $2', [
        newId('tgt', 5),
        ticket.queryId,
      ]),
    )
    await w.round()
    await settle(w)
    expect(await code(awaitDataRead(serve, ticket))).toBe('INTERNAL')
    expect(calls).toBe(0)
  })

  it('cleans up rows past their deadline', async () => {
    await db.asSuperuser((c) =>
      c.query(
        `INSERT INTO dataread.reads (query_id, kind, target_id, identity_id, caller_class, worker_id,
                                     request_id, request, created_at, deadline_at)
         VALUES ($1, 'query', $2, $3, 'agent', $4, $5, '\\x00', clock_timestamp() - interval '3 minutes',
                 clock_timestamp() - interval '2 minutes')`,
        [newId('qry', 1), newId('tgt', 1), OWNER.identityId, newId('prc', 1), newId('req', 1)],
      ),
    )
    const w = await manualWorker(async () => ROWS)
    await w.round()
    const { rows } = await db.asSuperuser((c) => c.query('SELECT 1 FROM dataread.reads'))
    expect(rows).toHaveLength(0)
  })

  it('serve never writes a result or a state; the worker never submits', async () => {
    await expect(
      db.asRole('exdb_serve', (c) => c.query(`UPDATE dataread.reads SET state = 'done'`)),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      db.asRole('exdb_worker', (c) =>
        c.query(
          `INSERT INTO dataread.reads (query_id, kind, target_id, identity_id, caller_class, worker_id,
                                       request_id, request, deadline_at)
           VALUES ($1, 'query', $2, $3, 'agent', $4, $5, '\\x00', clock_timestamp() + interval '1 minute')`,
          [newId('qry', 2), newId('tgt', 2), OWNER.identityId, newId('prc', 2), newId('req', 2)],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

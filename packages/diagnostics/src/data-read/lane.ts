import { generateKeyPairSync } from 'node:crypto'
import { isErrorCode } from '@exponetdb/contracts'
import type { ControlStore, Queryable } from '@exponetdb/control-store'
import type { JsonObject } from '@exponetdb/kernel'
import { b64u, fromB64u, hpkeOpen, hpkeSeal, rawPublicKey } from '@exponetdb/kernel/node'
import { DiagnosticsError } from '../errors.ts'
import type { DataReadOutcome, DataReadRequest } from './executor.ts'

/**
 * The data-read lane between `serve` and the worker
 * ([ADR-0028 §1](../../../../exponetdb-docs/01-architecture/adr/0028-data-read-lane.md#1-the-lane)):
 * a queue in the Control Store schema `dataread` that only ever holds
 * ciphertext for the waiting time.
 *
 * - The worker holds an X25519 key in memory only and registers its public
 *   half; a restart is a new process id and a new key.
 * - `serve` seals the request (statement, parameters, caps) with HPKE to
 *   that key and puts a fresh public key of its own inside, whose private
 *   half lives only in the waiting request; the worker seals the result to
 *   it. The associated data binds the query, the target and the worker.
 * - Both sides poll (the store offers no `LISTEN`); `serve` deletes the row
 *   once it has the result, the worker's cleanup every row past its
 *   deadline.
 *
 * Nothing here logs, measures or stores a value of a row in plain text.
 */
export const LANE_VERSION = 1
const REQUEST_INFO = new TextEncoder().encode('exdb-dataread-request-v1')
const RESULT_INFO = new TextEncoder().encode('exdb-dataread-result-v1')
const AEAD = 'aes-256-gcm'

/** A worker whose heartbeat is older than this is not offered reads. */
export const WORKER_LIVE_SECONDS = 30
export const WORKER_HEARTBEAT_MS = 10_000
/** Concurrent reads (owner decision 9): per grant (or person without one), per target, per installation. */
export const LANE_LIMITS = { owner: 2, target: 3, installation: 8 } as const
/** The sealed request and result as the bundle bounds them. */
export const MAX_SEALED_REQUEST_BYTES = 1_048_576
export const MAX_SEALED_RESULT_BYTES = 16_777_216
/** How long a finished or abandoned row may outlive its deadline before the cleanup deletes it. */
export const LANE_GRACE_SECONDS = 30

function aad(queryId: string, targetId: string, workerId: string): Uint8Array {
  return new TextEncoder().encode(
    `exdb-dataread-v${LANE_VERSION}\n${queryId}\n${targetId}\n${workerId}`,
  )
}

function pack(sealed: { enc: Uint8Array; ct: Uint8Array }): Buffer {
  return Buffer.concat([sealed.enc, sealed.ct])
}

function unpack(bytes: Uint8Array): { enc: Uint8Array; ct: Uint8Array } {
  return { enc: bytes.subarray(0, 32), ct: bytes.subarray(32) }
}

function keyPair(): { secret: Uint8Array; publicKey: Uint8Array } {
  const { privateKey } = generateKeyPairSync('x25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const secret = typeof jwk.d === 'string' ? fromB64u(jwk.d) : undefined
  if (secret === undefined || secret.length !== 32) throw new DiagnosticsError('INTERNAL')
  return { secret, publicKey: rawPublicKey(privateKey) }
}

// ----- serve: submit, await, cancel -----

/** Who asked: a cancel must name the same identity, client and grant. */
export interface DataReadOwner {
  readonly identityId: string
  readonly clientId: string | null
  readonly grantId: string | null
}

export interface DataReadSubmission extends DataReadOwner {
  readonly queryId: string
  readonly targetId: string
  readonly callerClass: 'agent' | 'human'
  readonly request: DataReadRequest
  /** How long the read may take, end to end (at most five minutes). */
  readonly timeoutMs: number
}

/** What `serve` keeps while it waits; the secret never leaves this process. */
export interface DataReadTicket {
  readonly queryId: string
  readonly targetId: string
  readonly workerId: string
  readonly deadlineMs: number
  readonly secret: Uint8Array
}

function busy(): DiagnosticsError {
  return new DiagnosticsError('RATE_LIMITED', undefined, { retryAfterSeconds: 2 })
}

/**
 * Submits one read: the bounds, a live worker, the sealed request. One
 * transaction under a table lock, so two submissions never both pass a
 * bound that only one of them fits.
 */
export async function submitDataRead(
  store: ControlStore,
  submission: DataReadSubmission,
  limits: {
    readonly owner: number
    readonly target: number
    readonly installation: number
  } = LANE_LIMITS,
): Promise<DataReadTicket> {
  const timeoutMs = Math.min(Math.max(1_000, Math.trunc(submission.timeoutMs)), 300_000)
  const reply = keyPair()
  return store.transaction('dataread.submit', async (tx) => {
    await tx.query('dataread.submit.lock', 'LOCK TABLE dataread.reads IN SHARE ROW EXCLUSIVE MODE')
    const { rows } = await tx.query(
      'dataread.submit.count',
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE target_id = $1)::int AS target,
              count(*) FILTER (WHERE CASE WHEN $2::text IS NULL
                                          THEN grant_id IS NULL AND identity_id = $3
                                          ELSE grant_id = $2 END)::int AS owner,
              EXISTS (SELECT 1 FROM dataread.reads WHERE query_id = $4) AS taken
         FROM dataread.reads
        WHERE state IN ('waiting', 'running') AND deadline_at > clock_timestamp()`,
      [submission.targetId, submission.grantId, submission.identityId, submission.queryId],
    )
    const counts = rows[0]
    if (counts === undefined) throw new DiagnosticsError('INTERNAL')
    if (counts.bool('taken')) {
      throw new DiagnosticsError('VALIDATION_FAILED', {
        errors: [
          { path: '/queryId', code: 'duplicate', message: 'This queryId was used already.' },
        ],
      })
    }
    if (
      counts.int('owner') >= limits.owner ||
      counts.int('target') >= limits.target ||
      counts.int('total') >= limits.installation
    ) {
      throw busy()
    }
    const worker = await tx.query(
      'dataread.submit.worker',
      `SELECT worker_id, public_key FROM dataread.workers
        WHERE heartbeat_at > clock_timestamp() - make_interval(secs => $1)
        ORDER BY random() LIMIT 1`,
      [WORKER_LIVE_SECONDS],
    )
    const chosen = worker.rows[0]
    if (chosen === undefined) {
      // No worker runs data reads: visible, never an empty result (C-28).
      throw new DiagnosticsError('CAPABILITY_UNAVAILABLE')
    }
    const workerId = chosen.text('worker_id')
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ v: LANE_VERSION, reply: b64u(reply.publicKey), read: submission.request }),
    )
    const sealed = pack(
      hpkeSeal(
        chosen.bytes('public_key'),
        REQUEST_INFO,
        aad(submission.queryId, submission.targetId, workerId),
        plaintext,
        AEAD,
      ),
    )
    plaintext.fill(0)
    if (sealed.length > MAX_SEALED_REQUEST_BYTES) {
      throw new DiagnosticsError('VALIDATION_FAILED', {
        errors: [
          {
            path: '',
            code: 'too_large',
            message: 'The statement and its parameters are too large.',
          },
        ],
      })
    }
    await tx.query(
      'dataread.submit.insert',
      `INSERT INTO dataread.reads (query_id, kind, target_id, identity_id, client_id, grant_id,
                                   caller_class, worker_id, request_id, request, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               clock_timestamp() + make_interval(secs => $11))`,
      [
        submission.queryId,
        submission.request.kind,
        submission.targetId,
        submission.identityId,
        submission.clientId,
        submission.grantId,
        submission.callerClass,
        workerId,
        submission.request.requestId,
        sealed,
        timeoutMs / 1000,
      ],
    )
    return {
      queryId: submission.queryId,
      targetId: submission.targetId,
      workerId,
      deadlineMs: Date.now() + timeoutMs,
      secret: reply.secret,
    }
  })
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

async function requestCancel(q: Queryable, queryId: string): Promise<void> {
  await q.query(
    'dataread.await.cancel',
    `UPDATE dataread.reads SET cancel_requested = true
      WHERE query_id = $1 AND state IN ('waiting', 'running')`,
    [queryId],
  )
}

async function drop(q: Queryable, queryId: string): Promise<void> {
  await q.query('dataread.await.delete', 'DELETE FROM dataread.reads WHERE query_id = $1', [
    queryId,
  ])
}

function openOutcome(ticket: DataReadTicket, result: Uint8Array): DataReadOutcome {
  const opened = hpkeOpen(
    ticket.secret,
    RESULT_INFO,
    aad(ticket.queryId, ticket.targetId, ticket.workerId),
    unpack(result),
    AEAD,
  )
  if (opened === undefined) throw new DiagnosticsError('INTERNAL')
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(opened)) as DataReadOutcome
  } catch {
    throw new DiagnosticsError('INTERNAL')
  } finally {
    opened.fill(0)
  }
}

/**
 * Waits for the worker's result and opens it. `signal` (a closed stream,
 * the client's cancellation) and the deadline mark the read canceled; the
 * worker stops exactly its own backend. A read no live worker holds is
 * `CAPABILITY_UNAVAILABLE`, never an empty result.
 */
export async function awaitDataRead(
  store: ControlStore,
  ticket: DataReadTicket,
  options: { readonly signal?: AbortSignal; readonly pollMs?: number } = {},
): Promise<DataReadOutcome> {
  const steady = options.pollMs ?? 200
  let wait = 25
  try {
    for (;;) {
      if (options.signal?.aborted === true) {
        await requestCancel(store, ticket.queryId)
        throw new DiagnosticsError('QUERY_CANCELED')
      }
      const { rows } = await store.query(
        'dataread.await.poll',
        `SELECT r.state, r.result, r.error_code,
                COALESCE(w.heartbeat_at > clock_timestamp() - make_interval(secs => $2), false) AS live
           FROM dataread.reads r
           LEFT JOIN dataread.workers w ON w.worker_id = r.worker_id
          WHERE r.query_id = $1`,
        [ticket.queryId, WORKER_LIVE_SECONDS],
      )
      const row = rows[0]
      if (row === undefined) {
        // Deleted by the cleanup: the deadline passed long ago.
        throw new DiagnosticsError('QUERY_TIMEOUT')
      }
      const state = row.text('state')
      if (state === 'done') {
        const outcome = openOutcome(ticket, row.bytes('result'))
        await drop(store, ticket.queryId)
        return outcome
      }
      if (state === 'failed' || state === 'canceled') {
        await drop(store, ticket.queryId)
        const code = row.textOrNull('error_code')
        throw new DiagnosticsError(
          state === 'canceled'
            ? 'QUERY_CANCELED'
            : code !== null && isErrorCode(code)
              ? code
              : 'INTERNAL',
        )
      }
      if (!row.bool('live')) {
        await drop(store, ticket.queryId)
        throw new DiagnosticsError('CAPABILITY_UNAVAILABLE')
      }
      const remaining = ticket.deadlineMs - Date.now()
      if (remaining <= 0) {
        await requestCancel(store, ticket.queryId)
        throw new DiagnosticsError(state === 'waiting' ? 'CAPABILITY_UNAVAILABLE' : 'QUERY_TIMEOUT')
      }
      await sleep(Math.min(wait, remaining), options.signal)
      wait = Math.min(steady, wait * 2)
    }
  } finally {
    ticket.secret.fill(0)
  }
}

/**
 * Cancels one of the owner's reads on a target: only the same identity,
 * client and grant reach it. `finished` when none of theirs with that id
 * runs (it ended, or never started): nothing tells another caller's query
 * apart from one that does not exist.
 */
export async function cancelDataRead(
  q: Queryable,
  owner: DataReadOwner,
  targetId: string,
  queryId: string,
): Promise<'canceled' | 'finished'> {
  const { rowCount } = await q.query(
    'dataread.cancel',
    `UPDATE dataread.reads SET cancel_requested = true
      WHERE query_id = $1 AND target_id = $2 AND identity_id = $3
        AND client_id IS NOT DISTINCT FROM $4 AND grant_id IS NOT DISTINCT FROM $5
        AND state IN ('waiting', 'running') AND deadline_at > clock_timestamp()`,
    [queryId, targetId, owner.identityId, owner.clientId, owner.grantId],
  )
  return rowCount > 0 ? 'canceled' : 'finished'
}

// ----- worker: register, claim, execute, write back -----

const AGENT_MAX_ROWS = 500
const HUMAN_MAX_ROWS = 5_000
const MAX_BYTES = 5 * 1024 * 1024
const MAX_TIMEOUT_MS = 60_000

function isParam(v: unknown): v is string | number | boolean | null {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}

/** The opened request, checked again here: the worker enforces the caps of the caller class itself. */
export function checkLaneRequest(
  value: unknown,
): { reply: Uint8Array; read: DataReadRequest } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const r = v['read'] as Record<string, unknown> | undefined
  if (
    v['v'] !== LANE_VERSION ||
    typeof v['reply'] !== 'string' ||
    typeof r !== 'object' ||
    r === null
  ) {
    return undefined
  }
  const reply = fromB64u(v['reply'])
  const callerClass = r['callerClass']
  const kind = r['kind']
  const params = r['params']
  const sensitive = r['sensitiveColumns']
  const maxRows = r['maxRows']
  const maxBytes = r['maxBytes']
  const timeout = r['statementTimeoutMs']
  if (
    reply === undefined ||
    reply.length !== 32 ||
    (kind !== 'query' && kind !== 'explain') ||
    (callerClass !== 'agent' && callerClass !== 'human') ||
    typeof r['sql'] !== 'string' ||
    r['sql'].length > 100_000 ||
    !Array.isArray(params) ||
    params.length > 100 ||
    !params.every(isParam) ||
    !Array.isArray(sensitive) ||
    sensitive.length > 256 ||
    !sensitive.every((s) => typeof s === 'string') ||
    typeof maxRows !== 'number' ||
    !Number.isInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > (callerClass === 'agent' ? AGENT_MAX_ROWS : HUMAN_MAX_ROWS) ||
    typeof maxBytes !== 'number' ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_BYTES ||
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_TIMEOUT_MS ||
    typeof r['analyze'] !== 'boolean' ||
    (callerClass === 'agent' && r['analyze'] === true) ||
    typeof r['requestId'] !== 'string' ||
    !/^req_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(r['requestId'])
  ) {
    return undefined
  }
  return {
    reply,
    read: {
      kind,
      sql: r['sql'],
      params,
      callerClass,
      maxRows,
      maxBytes,
      statementTimeoutMs: timeout,
      analyze: r['analyze'],
      sensitiveColumns: sensitive as string[],
      requestId: r['requestId'],
    },
  }
}

export interface DataReadWorkerOptions {
  readonly store: ControlStore
  /** This worker process (`prc_…`). */
  readonly workerId: string
  /** Runs one read on a fresh reader session of the target; never throws a database message. */
  readonly execute: (
    targetId: string,
    read: DataReadRequest,
    signal: AbortSignal,
  ) => Promise<DataReadOutcome>
  /** Reports a failure of the lane itself (event name and error; never a value). */
  readonly onError?: (event: string, error: unknown) => void
  /** Reports each finished read by outcome, for metrics. */
  readonly onFinished?: (outcome: 'done' | 'failed' | 'canceled') => void
  readonly pollMs?: number
  readonly maxInFlight?: number
}

interface InFlight {
  readonly controller: AbortController
  readonly done: Promise<void>
}

function codeOf(error: unknown): string {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'INTERNAL'
  return isErrorCode(code) ? code : 'INTERNAL'
}

/**
 * The worker's side of the lane: a key that lives in memory only, a
 * heartbeat, claims of the reads addressed to it, cancel requests
 * forwarded to exactly the read they name, and the cleanup of rows past
 * their deadline.
 */
export class DataReadWorker {
  readonly #o: DataReadWorkerOptions
  readonly #secret: Uint8Array
  readonly #publicKey: Uint8Array
  readonly #inFlight = new Map<string, InFlight>()
  #stopped = true
  #timer: NodeJS.Timeout | undefined
  #tick: Promise<void> = Promise.resolve()
  #lastBeat = 0
  #lastCleanup = 0

  constructor(options: DataReadWorkerOptions) {
    this.#o = options
    const keys = keyPair()
    this.#secret = keys.secret
    this.#publicKey = keys.publicKey
  }

  get inFlight(): number {
    return this.#inFlight.size
  }

  async #register(): Promise<void> {
    await this.#o.store.query(
      'dataread.worker.register',
      `INSERT INTO dataread.workers (worker_id, public_key) VALUES ($1, $2)
       ON CONFLICT (worker_id) DO NOTHING`,
      [this.#o.workerId, Buffer.from(this.#publicKey)],
    )
  }

  async #beat(): Promise<void> {
    const { rowCount } = await this.#o.store.query(
      'dataread.worker.heartbeat',
      'UPDATE dataread.workers SET heartbeat_at = clock_timestamp() WHERE worker_id = $1',
      [this.#o.workerId],
    )
    // Removed by another worker's cleanup after a long stall: the same key again.
    if (rowCount === 0) await this.#register()
  }

  /** Registers the key and starts the rounds (`loop: false`: only {@link round}, for tests). */
  async start(options: { readonly loop?: boolean } = {}): Promise<void> {
    await this.#register()
    this.#stopped = false
    this.#lastBeat = Date.now()
    if (options.loop === false) return
    const loop = () => {
      this.#tick = this.#once()
        .catch((error: unknown) => this.#o.onError?.('dataread.tick_failed', error))
        .finally(() => {
          if (!this.#stopped) this.#timer = setTimeout(loop, this.#o.pollMs ?? 200)
        })
    }
    loop()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    await this.#tick
    for (const f of this.#inFlight.values()) f.controller.abort()
    await Promise.all([...this.#inFlight.values()].map((f) => f.done))
    await this.#o.store
      .query('dataread.worker.unregister', 'DELETE FROM dataread.workers WHERE worker_id = $1', [
        this.#o.workerId,
      ])
      .catch((error: unknown) => this.#o.onError?.('dataread.unregister_failed', error))
    this.#secret.fill(0)
  }

  /** One round now (tests drive a worker started with `loop: false`). */
  round(): Promise<void> {
    return this.#once()
  }

  /** One round: heartbeat when due, cancels, claims, cleanup when due. */
  async #once(): Promise<void> {
    const now = Date.now()
    if (now - this.#lastBeat >= WORKER_HEARTBEAT_MS) {
      this.#lastBeat = now
      await this.#beat()
    }
    if (this.#inFlight.size > 0) {
      const { rows } = await this.#o.store.query(
        'dataread.worker.cancels',
        `SELECT query_id FROM dataread.reads
          WHERE worker_id = $1 AND state = 'running'
            AND (cancel_requested OR deadline_at <= clock_timestamp())`,
        [this.#o.workerId],
      )
      for (const row of rows) this.#inFlight.get(row.text('query_id'))?.controller.abort()
    }
    const room = (this.#o.maxInFlight ?? LANE_LIMITS.installation) - this.#inFlight.size
    if (room > 0) {
      const { rows } = await this.#o.store.query(
        'dataread.worker.claim',
        `UPDATE dataread.reads SET state = 'running', claimed_at = clock_timestamp()
          WHERE query_id IN (SELECT query_id FROM dataread.reads
                              WHERE worker_id = $1 AND state = 'waiting'
                              ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          RETURNING query_id, target_id, request, cancel_requested,
                    deadline_at <= clock_timestamp() AS expired`,
        [this.#o.workerId, room],
      )
      for (const row of rows) {
        const queryId = row.text('query_id')
        const targetId = row.text('target_id')
        const controller = new AbortController()
        if (row.bool('cancel_requested') || row.bool('expired')) controller.abort()
        const done = this.#run(queryId, targetId, row.bytes('request'), controller.signal)
          .catch((error: unknown) => this.#o.onError?.('dataread.run_failed', error))
          .finally(() => this.#inFlight.delete(queryId))
        this.#inFlight.set(queryId, { controller, done })
      }
    }
    if (now - this.#lastCleanup >= 30_000) {
      this.#lastCleanup = now
      await this.#o.store.query(
        'dataread.worker.cleanup',
        `DELETE FROM dataread.reads
          WHERE deadline_at < clock_timestamp() - make_interval(secs => $1)`,
        [LANE_GRACE_SECONDS],
      )
      await this.#o.store.query(
        'dataread.worker.cleanup_workers',
        `DELETE FROM dataread.workers
          WHERE worker_id <> $1 AND heartbeat_at < clock_timestamp() - interval '10 minutes'`,
        [this.#o.workerId],
      )
    }
  }

  async #finish(
    queryId: string,
    state: 'done' | 'failed' | 'canceled',
    result: Buffer | null,
    errorCode: string | null,
  ): Promise<void> {
    await this.#o.store.query(
      'dataread.worker.finish',
      `UPDATE dataread.reads
          SET state = $3, result = $4, error_code = $5, finished_at = clock_timestamp()
        WHERE query_id = $1 AND worker_id = $2 AND state = 'running'`,
      [queryId, this.#o.workerId, state, result, errorCode],
    )
    this.#o.onFinished?.(state)
  }

  async #run(
    queryId: string,
    targetId: string,
    sealed: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return this.#finish(queryId, 'canceled', null, null)
    const binding = aad(queryId, targetId, this.#o.workerId)
    const opened = hpkeOpen(this.#secret, REQUEST_INFO, binding, unpack(sealed), AEAD)
    let request: ReturnType<typeof checkLaneRequest>
    if (opened !== undefined) {
      try {
        request = checkLaneRequest(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(opened)),
        )
      } catch {
        request = undefined
      } finally {
        opened.fill(0)
      }
    }
    if (request === undefined) return this.#finish(queryId, 'failed', null, 'INTERNAL')
    let outcome: DataReadOutcome
    try {
      outcome = await this.#o.execute(targetId, request.read, signal)
    } catch (error) {
      return this.#finish(queryId, 'failed', null, codeOf(error))
    }
    if (signal.aborted && outcome.kind === 'refused' && outcome.code === 'QUERY_CANCELED') {
      return this.#finish(queryId, 'canceled', null, null)
    }
    let result = pack(
      hpkeSeal(
        request.reply,
        RESULT_INFO,
        binding,
        new TextEncoder().encode(JSON.stringify(outcome)),
        AEAD,
      ),
    )
    if (result.length > MAX_SEALED_RESULT_BYTES) {
      const tooLarge: DataReadOutcome = {
        kind: 'refused',
        code: 'QUERY_RESULT_TOO_LARGE',
        details: { cap: { kind: 'bytes', limit: MAX_SEALED_RESULT_BYTES } } satisfies JsonObject,
      }
      result = pack(
        hpkeSeal(
          request.reply,
          RESULT_INFO,
          binding,
          new TextEncoder().encode(JSON.stringify(tooLarge)),
          AEAD,
        ),
      )
    }
    return this.#finish(queryId, 'done', result, null)
  }
}

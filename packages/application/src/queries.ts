import { appendAuditEvent } from '@exponetdb/audit'
import type { Admission, Authorization, SubjectRef } from '@exponetdb/auth'
import type {
  AuditEventInput,
  ErrorCode,
  ExplainRequest,
  ExplainResult,
  QueryCancelResult,
  QueryHistory,
  QueryHistoryEntry,
  QueryRequest,
  QueryResult,
} from '@exponetdb/contracts'
import type { ControlStore, Queryable } from '@exponetdb/control-store'
import {
  awaitDataRead,
  cancelDataRead,
  type DataReadOutcome,
  type DataReadRequest,
  DiagnosticsError,
  type NormalizedStatement,
  prepareDataRead,
  submitDataRead,
} from '@exponetdb/diagnostics'
import { type Clock, type IdentityId, newId } from '@exponetdb/kernel'
import {
  evaluateRegistryPolicy,
  findTarget,
  RegistryError,
  type RegistryPolicyContext,
  type TargetRecord,
} from '@exponetdb/registry'
import type { CallerLike } from './registry.ts'

/**
 * The data-read use cases (Wave 7, ADR-0028): `sql_query`, `sql_explain`,
 * `sql_cancel` and their REST routes. In this order, for every read:
 *
 * 1. the central engine on the target the registry resolved
 *    (`query.run` / `query.explain`, scope `data.read:<tier>`);
 * 2. the policy rule `data.read` for this caller on this target (OD-13 (a):
 *    `humans_only` on production by default; an agent is every caller that
 *    is not a person in the Web App or the first-party CLI), which also
 *    names the sensitive columns to mask;
 * 3. the caps of the caller class, the parser admission and the normalized
 *    statement (`serve` holds no target credential);
 * 4. the lane to the worker, which admits again on the target and runs the
 *    read on a fresh reader session;
 * 5. the audit event `data.read` (normalized statement, digest, rows,
 *    truncation, duration, masked columns; never a value) in its own
 *    transaction **before** the result is returned: no audit, no rows.
 *
 * Masking applies to every caller: an unmasked read (`data.read_sensitive`)
 * has no action yet and is not offered (Wave 7 limit).
 */
export interface QueryHost {
  readonly store: ControlStore
  readonly clock: Clock
  /** The policy context of the registry services; undefined in a composition without them. */
  policy(): RegistryPolicyContext | undefined
  authorize(
    q: Queryable,
    action: string,
    caller: CallerLike,
    subject: SubjectRef,
  ): Promise<Authorization>
  admit(q: Queryable, action: string, caller: CallerLike): Promise<Admission>
  /** Who reads, as the audit records them (pseudonymous label, client, grant). */
  parties(caller: CallerLike): ReadParties
  /** Records a policy refusal of a high-risk action (`authz.denied`, reason `policy`). */
  denied(
    action: string,
    caller: CallerLike,
    subject: SubjectRef,
    error: { readonly code: string },
  ): void
}

export interface ReadParties {
  readonly actor: {
    readonly kind: 'human' | 'service'
    readonly identityId: IdentityId
    readonly label: string
  }
  readonly client: {
    readonly clientId: string | null
    readonly kind: 'web' | 'rest' | 'mcp' | 'cli' | 'ci'
    readonly grantId: string | null
    readonly sessionId?: string
  }
  /** The MCP tool the request came through (audit only). */
  readonly tool?: string
}

/** Caps by caller class (ADR-0028 §4). */
export const READ_CAPS = {
  agent: { rows: 500, defaultRows: 100, bytes: 5 * 1024 * 1024, statementTimeoutMs: 60_000 },
  human: { rows: 5_000, defaultRows: 1_000, bytes: 5 * 1024 * 1024, statementTimeoutMs: 60_000 },
} as const

/** The lane's deadline beyond the statement timeout: a fresh session, admission, the write back. */
const LANE_SLACK_MS = 30_000

export interface ReadOptions {
  readonly requestId: string
  /** A closed stream or a client's cancellation: the worker stops exactly this read. */
  readonly signal?: AbortSignal
}

type Kind = 'query' | 'explain'
type Refused = Extract<DataReadOutcome, { kind: 'refused' }>

/** An agent unless a person reads through the Web App or the first-party CLI (OD-13). */
function callerClassOf(parties: ReadParties): 'agent' | 'human' {
  return parties.actor.kind === 'human' &&
    (parties.client.kind === 'web' || parties.client.kind === 'cli')
    ? 'human'
    : 'agent'
}

function codeOf(error: unknown): ErrorCode {
  if (error instanceof DiagnosticsError || error instanceof RegistryError) return error.code
  return 'INTERNAL'
}

/** One data read as its audit event records it. */
export interface DataReadAuditEntry {
  readonly kind: Kind
  readonly queryId: string
  readonly requestId: string
  readonly statement: NormalizedStatement
  readonly analyze: boolean
  readonly callerClass: 'agent' | 'human'
  readonly outcome:
    | Exclude<DataReadOutcome, Refused>
    | { readonly error: ErrorCode; readonly reason?: string }
}

/**
 * The `data.read` audit event of one read (Wave 7): the normalized
 * statement (constants replaced, its first 256 characters), its digest, the
 * caller class and, for a completed query, rows, truncation, duration and
 * the masked columns; never a value. The query history (Wave 8) reads
 * exactly these members back.
 */
export function dataReadAuditEvent(
  target: Pick<TargetRecord, 'targetId' | 'path' | 'tier' | 'placement'>,
  parties: ReadParties,
  entry: DataReadAuditEntry,
): AuditEventInput {
  const o = entry.outcome
  const ok = !('error' in o)
  const facts: Record<string, string | number | boolean | string[]> = ok
    ? o.kind === 'query'
      ? {
          rows: o.rowCount,
          truncated: o.truncated,
          ...(o.truncation === null ? {} : { truncation: o.truncation.reason }),
          durationMs: Math.trunc(o.durationMs),
          maskedColumns: o.columns
            .filter((c) => c.masked)
            .map((c) => c.name)
            .slice(0, 64),
          rlsRelations: o.rlsRelations.length,
        }
      : { durationMs: Math.trunc(o.durationMs) }
    : o.reason === undefined
      ? {}
      : { reason: o.reason.slice(0, 64) }
  return {
    action: 'data.read',
    phase: ok ? 'completed' : 'failed',
    actor: {
      kind: parties.actor.kind,
      identityId: parties.actor.identityId,
      label: parties.actor.label as never,
    },
    client: {
      clientId: parties.client.clientId as never,
      kind: parties.client.kind,
      grantId: parties.client.grantId as never,
      ...(parties.client.sessionId === undefined
        ? {}
        : { sessionId: parties.client.sessionId as never }),
    },
    subject: {
      targetId: target.targetId as never,
      targetPath: target.path,
      tier: target.tier,
      ...(target.placement === null ? {} : { clusterId: target.placement.clusterId as never }),
    },
    request: { requestId: entry.requestId as never },
    changes: {
      kind: entry.kind,
      queryId: entry.queryId,
      statement: entry.statement.text.slice(0, 256),
      statementDigest: entry.statement.digest,
      callerClass: entry.callerClass,
      ...(entry.analyze ? { analyze: true } : {}),
      ...(parties.tool === undefined ? {} : { tool: parties.tool }),
      ...facts,
    },
    result: ok ? { status: 'succeeded' } : { status: 'failed', errorCode: o.error },
  }
}

export class QueryUseCases {
  readonly #h: QueryHost

  constructor(host: QueryHost) {
    this.#h = host
  }

  /** Admission first, then the lookup, then the engine on the resolved target (error-model.md §4). */
  async #target(action: string, caller: CallerLike, ref: string): Promise<TargetRecord> {
    await this.#h.admit(this.#h.store, action, caller)
    const target = await findTarget(this.#h.store, ref)
    if (target === undefined) throw new RegistryError('TARGET_NOT_FOUND')
    await this.#h.authorize(this.#h.store, action, caller, {
      kind: 'target',
      targetId: target.targetId,
    })
    return target
  }

  /**
   * The `data.read` rule for this caller on this target. Anything but an
   * allowing decision refuses (an invalid setting is `unknown`: fail closed).
   */
  async #policy(
    action: 'query.run' | 'query.explain',
    caller: CallerLike,
    target: TargetRecord,
    parties: ReadParties,
  ): Promise<readonly string[]> {
    const context = this.#h.policy()
    if (context === undefined) throw new DiagnosticsError('CONTROL_PLANE_DEGRADED')
    const decision = await evaluateRegistryPolicy(this.#h.store, context, {
      kind: action,
      actor: {
        kind: parties.actor.kind,
        identityId: parties.actor.identityId,
        reauthAt: null,
        client: parties.client.kind,
      },
      subject: {
        targetId: target.targetId,
        tier: target.tier,
        productId: target.productId,
        projectId: target.projectId,
        environmentId: target.environmentId,
      },
      content: {},
    })
    const rule = decision.rules.find((r) => r.id === 'data.read')
    if (rule === undefined || decision.decision !== 'allow' || rule.result !== 'pass') {
      const error = new DiagnosticsError('DATA_READ_NOT_PERMITTED')
      this.#h.denied(action, caller, { kind: 'target', targetId: target.targetId }, error)
      throw error
    }
    const sensitive = rule.facts['sensitiveColumns']
    return Array.isArray(sensitive)
      ? sensitive.filter((c): c is string => typeof c === 'string')
      : []
  }

  /** The `data.read` audit event; it must be written before anything is returned. */
  async #audit(
    target: TargetRecord,
    parties: ReadParties,
    entry: DataReadAuditEntry,
  ): Promise<void> {
    await this.#h.store.transaction('application.data_read.audit', (tx) =>
      appendAuditEvent(tx, dataReadAuditEvent(target, parties, entry), { clock: this.#h.clock }),
    )
  }

  async #read(
    action: 'query.run' | 'query.explain',
    caller: CallerLike,
    ref: string,
    body: {
      readonly sql: string
      readonly params: readonly (string | number | boolean | null)[]
      readonly maxRows?: number | undefined
      readonly analyze: boolean
      readonly queryId?: string | undefined
    },
    options: ReadOptions,
  ): Promise<{
    outcome: Exclude<DataReadOutcome, Refused>
    queryId: string
    statement: NormalizedStatement
  }> {
    const kind: Kind = action === 'query.run' ? 'query' : 'explain'
    const target = await this.#target(action, caller, ref)
    // As every other read of a target's database: only an active or suspended target is read.
    if (target.state !== 'active' && target.state !== 'suspended') {
      throw new DiagnosticsError(
        target.state === 'decommissioned' ? 'TARGET_NOT_FOUND' : 'TARGET_UNAVAILABLE',
      )
    }
    const parties = this.#h.parties(caller)
    const sensitiveColumns = await this.#policy(action, caller, target, parties)
    const callerClass = callerClassOf(parties)
    const caps = READ_CAPS[callerClass]
    const queryId = body.queryId ?? newId('qry', this.#h.clock.nowMs())
    const prepared = await prepareDataRead(target.placement?.serverVersionNum ?? null, {
      kind,
      sql: body.sql,
      analyze: body.analyze,
    })
    const record = (
      outcome:
        | Exclude<DataReadOutcome, Refused>
        | { readonly error: ErrorCode; readonly reason?: string },
    ) =>
      this.#audit(target, parties, {
        kind,
        queryId,
        requestId: options.requestId,
        statement: prepared.statement,
        analyze: body.analyze,
        callerClass,
        outcome,
      })
    const refuse = async (refusal: Refused): Promise<never> => {
      await record({
        error: refusal.code,
        ...(refusal.reason === undefined ? {} : { reason: refusal.reason }),
      })
      throw new DiagnosticsError(refusal.code, refusal.details)
    }
    if (!prepared.ok) return refuse(prepared.refusal)
    if (body.analyze && callerClass === 'agent') {
      // EXPLAIN ANALYZE executes the statement (ADR-0028 §4): never for an agent.
      return refuse({ kind: 'refused', code: 'QUERY_NOT_READ_ONLY', reason: 'explain_analyze' })
    }
    const request: DataReadRequest = {
      kind,
      sql: body.sql,
      params: body.params,
      callerClass,
      maxRows: Math.min(body.maxRows ?? caps.defaultRows, caps.rows),
      maxBytes: caps.bytes,
      statementTimeoutMs: caps.statementTimeoutMs,
      analyze: body.analyze,
      sensitiveColumns,
      requestId: options.requestId,
    }
    // Refused before it entered the lane (bounds, no worker, a reused id): not a read, no audit.
    const ticket = await submitDataRead(this.#h.store, {
      identityId: parties.actor.identityId,
      clientId: parties.client.clientId,
      grantId: parties.client.grantId,
      queryId,
      targetId: target.targetId,
      callerClass,
      request,
      timeoutMs: caps.statementTimeoutMs + LANE_SLACK_MS,
    })
    let outcome: DataReadOutcome
    try {
      outcome = await awaitDataRead(this.#h.store, ticket, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      await record({ error: codeOf(error) })
      throw error
    }
    if (outcome.kind === 'refused') return refuse(outcome)
    await record(outcome)
    return { outcome, queryId, statement: prepared.statement }
  }

  /** `sql_query` and `POST /targets/{target}/queries`. */
  async run(
    caller: CallerLike,
    ref: string,
    body: QueryRequest,
    options: ReadOptions,
  ): Promise<QueryResult> {
    const { outcome, queryId, statement } = await this.#read(
      'query.run',
      caller,
      ref,
      {
        sql: body.sql,
        params: body.params ?? [],
        maxRows: body.maxRows,
        analyze: false,
        queryId: body.queryId,
      },
      options,
    )
    if (outcome.kind !== 'query') throw new DiagnosticsError('INTERNAL')
    const { kind: _kind, ...rest } = outcome
    return {
      queryId,
      ...rest,
      durationMs: Math.trunc(rest.durationMs),
      statementDigest: statement.digest,
    } as QueryResult
  }

  /** `sql_explain` and `POST /targets/{target}/explain`. */
  async explain(
    caller: CallerLike,
    ref: string,
    body: ExplainRequest,
    options: ReadOptions,
  ): Promise<ExplainResult> {
    const { outcome, queryId } = await this.#read(
      'query.explain',
      caller,
      ref,
      {
        sql: body.sql,
        params: body.params ?? [],
        analyze: body.analyze ?? false,
        queryId: body.queryId,
      },
      options,
    )
    if (outcome.kind !== 'explain') throw new DiagnosticsError('INTERNAL')
    return {
      queryId,
      plan: outcome.plan,
      summary: outcome.summary,
      durationMs: Math.trunc(outcome.durationMs),
    } as ExplainResult
  }

  /**
   * `GET /targets/{target}/queries/history` (Wave 8): the caller's own data
   * reads on this target, newest first by audit sequence, from the audit's
   * `data.read` events. Authorized like a read of the target
   * (`data.read:<tier>`, a restricted grant sees only its targets). "Own"
   * is the audit's actor: the caller's identity, whichever client read in
   * its name (a person sees the reads an MCP client made for them, a
   * service account its own); another identity's reads never appear. Only
   * what the audit holds is returned: the redacted statement (its first
   * 256 characters), never the text the caller sent.
   */
  async history(
    caller: CallerLike,
    ref: string,
    query: { readonly limit?: number | undefined; readonly cursor?: string | undefined },
  ): Promise<QueryHistory> {
    const before = decodeHistoryCursor(query.cursor)
    const target = await this.#target('query.history.list', caller, ref)
    const identityId = this.#h.parties(caller).actor.identityId
    const limit = query.limit ?? 50
    const { rows } = await this.#h.store.query(
      'application.query_history',
      `SELECT seq, event FROM audit.audit_events
        WHERE action = 'data.read' AND actor_id = $1
          AND event::jsonb -> 'subject' ->> 'targetId' = $2
          AND ($3::bigint IS NULL OR seq < $3)
        ORDER BY seq DESC
        LIMIT $4`,
      [identityId, target.targetId, before, limit + 1],
    )
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      items: page.map((r) => historyEntry(JSON.parse(r.text('event')) as Record<string, unknown>)),
      nextCursor:
        rows.length > limit && last !== undefined ? encodeHistoryCursor(last.text('seq')) : null,
      source: 'audit',
    }
  }

  /**
   * `sql_cancel` and `POST /targets/{target}/queries/{queryId}/cancel`:
   * authorized like a read of the target; reaches only the caller's own
   * read (same identity, client and grant).
   */
  async cancel(caller: CallerLike, ref: string, queryId: string): Promise<QueryCancelResult> {
    const target = await this.#target('query.cancel', caller, ref)
    const parties = this.#h.parties(caller)
    const outcome = await cancelDataRead(
      this.#h.store,
      {
        identityId: parties.actor.identityId,
        clientId: parties.client.clientId,
        grantId: parties.client.grantId,
      },
      target.targetId,
      queryId,
    )
    return { queryId, outcome } as QueryCancelResult
  }
}

const HISTORY_CURSOR_PREFIX = 'qh1_'

function encodeHistoryCursor(seq: string): string {
  return HISTORY_CURSOR_PREFIX + Buffer.from(seq, 'utf8').toString('base64url')
}

function decodeHistoryCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null
  const seq = cursor.startsWith(HISTORY_CURSOR_PREFIX)
    ? Buffer.from(cursor.slice(HISTORY_CURSOR_PREFIX.length), 'base64url').toString('utf8')
    : ''
  if (!/^[1-9][0-9]{0,18}$/.test(seq)) {
    throw new RegistryError('VALIDATION_FAILED', {
      errors: [{ path: '/cursor', code: 'invalid', message: 'Unknown cursor.' }],
    })
  }
  return seq
}

const HISTORY_CLIENTS: ReadonlySet<unknown> = new Set(['web', 'rest', 'mcp', 'cli', 'ci'])

/**
 * One history entry from a stored `data.read` event, member by member. What
 * the event does not hold stays null (an EXPLAIN has no row count, a failed
 * read no duration); an event without its query id, statement or digest
 * cannot be shown truthfully and fails the read.
 */
function historyEntry(e: Record<string, unknown>): QueryHistoryEntry {
  const o = (v: unknown) =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const changes = o(e['changes'])
  const result = o(e['result'])
  const client = o(e['client'])
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
  const queryId = text(changes['queryId'])
  const statement = text(changes['statement'])
  const digest = text(changes['statementDigest'])
  const occurredAt = text(e['occurredAt'])
  const kind = changes['kind']
  const clientKind = client['kind']
  const callerClass = changes['callerClass']
  if (
    queryId === undefined ||
    statement === undefined ||
    digest === undefined ||
    occurredAt === undefined ||
    (kind !== 'query' && kind !== 'explain') ||
    (callerClass !== 'human' && callerClass !== 'agent') ||
    !HISTORY_CLIENTS.has(clientKind)
  ) {
    throw new DiagnosticsError('INTERNAL')
  }
  const succeeded = result['status'] === 'succeeded'
  const completedQuery = succeeded && kind === 'query'
  return {
    queryId,
    kind,
    occurredAt,
    statement: statement.slice(0, 256),
    statementDigest: digest,
    rows: completedQuery ? count(changes['rows']) : null,
    truncated:
      completedQuery && typeof changes['truncated'] === 'boolean' ? changes['truncated'] : null,
    durationMs: succeeded ? count(changes['durationMs']) : null,
    outcome: succeeded ? 'succeeded' : 'failed',
    errorCode: succeeded ? null : (text(result['errorCode']) ?? null),
    client: clientKind,
    callerClass,
  } as QueryHistoryEntry
}

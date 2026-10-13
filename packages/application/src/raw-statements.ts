import { appendAuditEvent } from '@exponetdb/audit'
import { AuthError } from '@exponetdb/auth'
import type { ErrorCode, RawStatement } from '@exponetdb/contracts'
import { DiagnosticsError, readRawStatement, type SnapshotDeps } from '@exponetdb/diagnostics'
import type { Clock } from '@exponetdb/kernel'
import { findTarget, RegistryError, type TargetRecord } from '@exponetdb/registry'
import type { ReadParties } from './queries.ts'
import type { CallerLike, RegistryHost } from './registry.ts'

/**
 * The raw statement view (`statement.raw.get`, Wave 8, owner decision S2;
 * [statement-redaction.md §4](../../../exponetdb-docs/03-database-model/statement-redaction.md#4-raw-text-access)).
 * In this order:
 *
 * 1. the central engine on the target the registry resolved:
 *    `diagnostics.read_sensitive` covering the target, a person in the Web
 *    App (`humanOnly`, client `web`; an API key, an OAuth client and MCP
 *    are refused by the action itself) re-authenticated within 15 minutes
 *    (`reauthWithinSeconds: 900`); a denial that names a missing permission
 *    is `authz.denied` (`isHighRiskAction`);
 * 2. the live lookup on the target through serve's observer session
 *    (`readRawStatement`): the digest is recomputed from the text read,
 *    secrets are removed, nothing is stored;
 * 3. the audit event `diagnostics.raw_statement_viewed` (target, digest,
 *    where it was found, outcome; **never the text**) in its own
 *    transaction **before** anything is returned: no audit, no text. A
 *    statement that is not available is audited too (`phase: failed`, the
 *    reason).
 */
export interface RawStatementHost {
  readonly store: RegistryHost['store']
  readonly clock: Clock
  /** Serve's observer reads; undefined in a composition without the registry. */
  observation(): SnapshotDeps | undefined
  readonly authorize: RegistryHost['authorize']
  readonly admit: RegistryHost['admit']
  parties(caller: CallerLike): ReadParties
}

export interface RawStatementRequest {
  readonly digest: string
  readonly pid?: number | undefined
  readonly backendStart?: string | undefined
}

const ACTION = 'statement.raw.get'
export const RAW_STATEMENT_EVENT = 'diagnostics.raw_statement_viewed'

export class RawStatementUseCases {
  readonly #h: RawStatementHost

  constructor(host: RawStatementHost) {
    this.#h = host
  }

  /** One statement of one target, per request; there is no batch form. */
  async view(
    caller: CallerLike,
    ref: string,
    request: RawStatementRequest,
    options: { readonly requestId: string },
  ): Promise<RawStatement> {
    // Admission first, then the lookup (error-model.md §4): no access, no existence.
    await this.#h.admit(this.#h.store, ACTION, caller)
    const target = await findTarget(this.#h.store, ref)
    if (target === undefined) throw new RegistryError('TARGET_NOT_FOUND')
    await this.#h.authorize(this.#h.store, ACTION, caller, {
      kind: 'target',
      targetId: target.targetId,
    })
    if (request.backendStart !== undefined && request.pid === undefined) {
      throw new AuthError('VALIDATION_FAILED', {
        details: {
          errors: [
            {
              path: '/backendStart',
              code: 'requires_pid',
              message: 'backendStart names the start of the session given by pid.',
            },
          ],
        },
      })
    }
    const deps = this.#h.observation()
    if (deps === undefined) throw new AuthError('CONTROL_PLANE_DEGRADED')
    const parties = this.#h.parties(caller)
    let statement: RawStatement
    try {
      statement = await readRawStatement(deps, target, {
        digest: request.digest,
        ...(request.pid === undefined
          ? {}
          : { session: { pid: request.pid, backendStart: request.backendStart } }),
      })
    } catch (error) {
      const code: ErrorCode =
        error instanceof DiagnosticsError || error instanceof RegistryError
          ? error.code
          : 'INTERNAL'
      const reason =
        error instanceof DiagnosticsError && typeof error.details?.['reason'] === 'string'
          ? error.details['reason']
          : undefined
      await this.#audit(target, parties, options.requestId, request, {
        error: code,
        ...(reason === undefined ? {} : { reason }),
      })
      throw error
    }
    await this.#audit(target, parties, options.requestId, request, statement)
    return statement
  }

  async #audit(
    target: TargetRecord,
    parties: ReadParties,
    requestId: string,
    request: RawStatementRequest,
    outcome: RawStatement | { readonly error: ErrorCode; readonly reason?: string },
  ): Promise<void> {
    const ok = !('error' in outcome)
    const facts: Record<string, string | number | boolean> = ok
      ? {
          view: outcome.origin.view,
          ...(outcome.origin.view === 'pg_stat_activity' ? { pid: outcome.origin.pid } : {}),
          mode: outcome.redaction.mode,
          removed: outcome.redaction.removed,
          truncated: outcome.truncated,
        }
      : outcome.reason === undefined
        ? {}
        : { reason: outcome.reason }
    await this.#h.store.transaction('application.raw_statement.audit', (tx) =>
      appendAuditEvent(
        tx,
        {
          action: RAW_STATEMENT_EVENT,
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
            ...(target.placement === null
              ? {}
              : { clusterId: target.placement.clusterId as never }),
          },
          request: { requestId: requestId as never },
          changes: {
            statementDigest: request.digest,
            ...(request.pid === undefined ? {} : { requestedPid: request.pid }),
            ...facts,
          },
          result: ok ? { status: 'succeeded' } : { status: 'failed', errorCode: outcome.error },
        },
        { clock: this.#h.clock },
      ),
    )
  }
}

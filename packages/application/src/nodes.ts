import { appendAuditEvent } from '@exponetdb/audit'
import { AuthError } from '@exponetdb/auth'
import {
  type AccessRole,
  type EnrollmentTokenReveal,
  type Node,
  type NodeChange,
  type NodeInspectionRequest,
  type NodeObservation,
  NodeObservationSchema,
  NodeSchema,
  type NodeStatus,
  NodeStatusSchema,
  type OperationView,
  type PlanView,
} from '@exponetdb/contracts'
import { isId } from '@exponetdb/kernel'
import {
  getNode,
  listNodes,
  listObservations,
  NodeError,
  nodeState,
  planCredentialRotation,
  planNodeDecommission,
  planNodeEnroll,
  planNodeInspection,
  planNodeOperation,
  planNodeRevoke,
  revealEnrollmentToken,
} from '@exponetdb/nodes'
import { decodeCursor, encodeCursor, type PageRequest } from '@exponetdb/registry'
import { type CallerLike, type Idempotency, type RegistryHost, registryActor } from './registry.ts'

/**
 * The node use cases ([control-plane.md §4, §7](../../../exponetdb-docs/07-node-agent/control-plane.md#7-interfaces)):
 * plans of `node.enroll`, `node.revoke` and `node.decommission` (applied
 * through `plan.apply`, which enforces their re-authentication), the
 * one-time reveal of an enrollment token, and node reads. Same engine and
 * rules as the registry; `packages/nodes` holds the domain.
 */
export class NodeUseCases {
  readonly #h: RegistryHost

  constructor(host: RegistryHost) {
    this.#h = host
  }

  #services() {
    const s = this.#h.services
    if (s === undefined) {
      throw new AuthError('CONTROL_PLANE_DEGRADED')
    }
    return s
  }

  planEnrollment(caller: CallerLike, serverId: string, idem?: Idempotency) {
    const { plans } = this.#services()
    return this.#h.plan(
      caller,
      'node.enroll.plan',
      idem,
      async () => ({ kind: 'server', serverId }),
      (tx, actor) => planNodeEnroll(tx, { policy: plans.policy }, actor, serverId),
    )
  }

  async #nodeSubject(nodeId: string) {
    const node = await nodeState(this.#h.store, nodeId)
    if (node === undefined) {
      throw new NodeError('NOT_FOUND')
    }
    return { kind: 'server' as const, serverId: node.serverId }
  }

  planRevocation(caller: CallerLike, nodeId: string, idem?: Idempotency) {
    const { plans } = this.#services()
    return this.#h.plan(
      caller,
      'node.revoke.plan',
      idem,
      () => this.#nodeSubject(nodeId),
      (tx, actor) => planNodeRevoke(tx, { policy: plans.policy }, actor, nodeId),
    )
  }

  planDecommissioning(caller: CallerLike, nodeId: string, idem?: Idempotency) {
    const { plans } = this.#services()
    return this.#h.plan(
      caller,
      'node.decommission.plan',
      idem,
      () => this.#nodeSubject(nodeId),
      (tx, actor) => planNodeDecommission(tx, { policy: plans.policy }, actor, nodeId),
    )
  }

  /**
   * The one-time reveal (Web App, re-authentication, the identity that
   * applied `node.enroll`): the only moment the token secret exists. The
   * audit event names the token, never its value.
   */
  async revealToken(
    requestId: string,
    caller: CallerLike,
    tokenId: string,
  ): Promise<EnrollmentTokenReveal> {
    const { plans } = this.#services()
    if (!isId('ent', tokenId)) {
      throw new NodeError('NOT_FOUND')
    }
    return this.#h.store.transaction('application.nodes.reveal', async (tx) => {
      const { rows } = await tx.query(
        'application.nodes.token_server',
        'SELECT server_id FROM nodes.enrollment_tokens WHERE token_id = $1',
        [tokenId],
      )
      const serverId = rows[0]?.text('server_id')
      if (serverId === undefined || !isId('srv', serverId)) {
        throw new NodeError('NOT_FOUND')
      }
      await this.#h.authorize(tx, 'node.enrollment_token.reveal', caller, {
        kind: 'server',
        serverId,
      })
      const actor = registryActor(this.#h.planActor(caller))
      const revealed = await revealEnrollmentToken(tx, this.#h.keyring, this.#h.clock, {
        tokenId,
        identityId: actor.identityId,
        installationId: plans.installationId,
      })
      // Verified by reading back what the reveal wrote, in its transaction:
      // the token is issued, with a redeem hash and a bind key (Principle 3).
      const check = await tx.query(
        'application.nodes.reveal_check',
        `SELECT 1 FROM nodes.enrollment_tokens
          WHERE token_id = $1 AND state = 'issued' AND redeem_hash IS NOT NULL
            AND bind_secret_id IS NOT NULL`,
        [tokenId],
      )
      if (check.rows.length !== 1) {
        throw new NodeError('INTERNAL')
      }
      await appendAuditEvent(
        tx,
        {
          action: 'node.enrollment_token.revealed',
          phase: 'completed',
          actor: {
            kind: 'human',
            identityId: actor.identityId,
            label: actor.label as never,
            reauthAt: actor.reauthAt,
          },
          client: { clientId: actor.clientId ?? null, kind: actor.client ?? 'web' },
          subject: { serverId },
          changes: { tokenId, expiresAt: revealed.expiresAt },
          result: { status: 'succeeded', applyOutcome: 'applied', verificationOutcome: 'passed' },
          ...(isId('req', requestId) ? { request: { requestId } } : {}),
        },
        { clock: this.#h.clock },
      )
      return {
        tokenId: tokenId,
        serverId,
        token: revealed.token,
        expiresAt: revealed.expiresAt,
      }
    })
  }

  // ----- capability operations (control-plane.md §9) -----

  /** `node.inspect`: planned and accepted at once; the worker runs the job (§9.2). */
  inspect(
    caller: CallerLike,
    nodeId: string,
    request: NodeInspectionRequest,
    idem?: Idempotency,
  ): Promise<OperationView> {
    const { plans } = this.#services()
    return this.#h.inline(
      caller,
      'node.inspect',
      idem,
      () => this.#nodeSubject(nodeId),
      (tx, actor) => planNodeInspection(tx, { policy: plans.policy }, actor, nodeId, request),
    )
  }

  /** The latest node-signed observations of a node (§9.2). */
  async observations(
    caller: CallerLike,
    nodeId: string,
    filter: { readonly capability?: string; readonly clusterId?: string },
  ): Promise<{ items: NodeObservation[] }> {
    const subject = await this.#nodeSubject(nodeId)
    await this.#h.authorize(this.#h.store, 'node.get', caller, subject)
    const items = await listObservations(this.#h.store, nodeId, filter)
    return { items: items.map((o) => NodeObservationSchema.parse(o)) }
  }

  /** `node.plan`: a PostgreSQL operation through the node, bound to an observation (§9.3). */
  planOperation(
    caller: CallerLike,
    nodeId: string,
    request: { readonly clusterId: string; readonly change: NodeChange },
    idem?: Idempotency,
  ): Promise<PlanView> {
    const { plans } = this.#services()
    return this.#h.plan(
      caller,
      'node.plan',
      idem,
      async () => ({ kind: 'cluster', clusterId: request.clusterId }),
      (tx, actor) => planNodeOperation(tx, { policy: plans.policy }, actor, nodeId, request),
    )
  }

  /** `credential.rotate` on an agent-managed cluster (§9.7). */
  planCredentialRotation(
    caller: CallerLike,
    clusterId: string,
    role: AccessRole,
    idem?: Idempotency,
  ): Promise<PlanView> {
    const { plans } = this.#services()
    return this.#h.plan(
      caller,
      'credential.rotate.plan',
      idem,
      async () => ({ kind: 'cluster', clusterId }),
      (tx, actor) => planCredentialRotation(tx, { policy: plans.policy }, actor, clusterId, role),
    )
  }

  async nodes(
    caller: CallerLike,
    request: PageRequest,
  ): Promise<{ items: Node[]; nextCursor: string | null }> {
    await this.#h.authorize(this.#h.store, 'node.list', caller, { kind: 'installation' })
    const page = await listNodes(
      this.#h.store,
      { after: decodeCursor(request.cursor), limit: request.limit },
      this.#h.clock.nowMs(),
    )
    return {
      items: page.items.map((n) => NodeSchema.parse(n)),
      nextCursor: page.more && page.last !== null ? encodeCursor(page.last) : null,
    }
  }

  async node(caller: CallerLike, nodeId: string): Promise<NodeStatus> {
    const subject = await this.#nodeSubject(nodeId)
    await this.#h.authorize(this.#h.store, 'node.get', caller, subject)
    const node = await getNode(this.#h.store, nodeId, this.#h.clock.nowMs())
    if (node === undefined) {
      throw new NodeError('NOT_FOUND')
    }
    return NodeStatusSchema.parse(node)
  }
}

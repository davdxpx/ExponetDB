import { appendAuditEvent } from '@exponetdb/audit'
import { AuthError } from '@exponetdb/auth'
import {
  type AccessRole,
  type EnrollmentTokenReveal,
  type Node,
  type NodeCertificates,
  NodeCertificatesSchema,
  type NodeChange,
  type NodeConfigUpdateRequest,
  type NodeInspectionRequest,
  type NodeJob,
  NodeJobSchema,
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
  listNodeJobs,
  listNodes,
  listObservations,
  NodeError,
  nodeState,
  planCredentialRotation,
  planNodeConfigUpdate,
  planNodeDecommission,
  planNodeEnroll,
  planNodeInspection,
  planNodeOperation,
  planNodeRevoke,
  readCertificates,
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

  /** `node.config.update`: job keys added to or removed from one node (control-plane.md §9.8). */
  planConfigUpdate(
    caller: CallerLike,
    nodeId: string,
    request: NodeConfigUpdateRequest,
    idem?: Idempotency,
  ): Promise<PlanView> {
    const { plans } = this.#services()
    return this.#h.plan(
      caller,
      'node.config.update.plan',
      idem,
      () => this.#nodeSubject(nodeId),
      (tx, actor) => planNodeConfigUpdate(tx, { policy: plans.policy }, actor, nodeId, request),
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
    requested: CallerLike,
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
      // The person's CLI proves presence with a step-up bound to this token (ADR-0026).
      const stepUp = await this.#h.withStepUp(tx, requested, {
        action: 'node.enrollment_token.reveal',
        planId: null,
        planHash: null,
        tokenId,
      })
      const caller = stepUp.caller
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
      await stepUp.redeem()
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
      (tx, actor) =>
        planNodeOperation(
          tx,
          { policy: plans.policy, egressAddresses: plans.egressAddresses ?? [] },
          actor,
          nodeId,
          request,
        ),
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

  /**
   * `node.list`. A grant restricted to tiers or targets sees the nodes whose
   * server it covers (the server's derived tier; a server without a known
   * tier passes only an unrestricted grant), never a refusal of the whole
   * list (authorization.md §1, Wave 7 decision). At most `SCAN_LIMIT` nodes
   * are examined per call; the cursor continues the scan.
   */
  async nodes(
    caller: CallerLike,
    request: PageRequest,
  ): Promise<{ items: Node[]; nextCursor: string | null }> {
    const restriction = this.#h.restrictions(caller)
    if (
      restriction !== undefined &&
      (restriction.targetIds !== undefined || (restriction.tiers?.length ?? 2) < 2)
    ) {
      return this.#visibleNodes(caller, request)
    }
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

  async #visibleNodes(
    caller: CallerLike,
    request: PageRequest,
  ): Promise<{ items: Node[]; nextCursor: string | null }> {
    const SCAN_LIMIT = 2000
    await this.#h.admit(this.#h.store, 'node.list', caller)
    const decided = new Map<string, boolean>()
    const items: Node[] = []
    let after = decodeCursor(request.cursor)
    let scanned = 0
    for (;;) {
      const page = await listNodes(
        this.#h.store,
        { after, limit: Math.min(200, SCAN_LIMIT - scanned) },
        this.#h.clock.nowMs(),
      )
      for (const node of page.items) {
        scanned++
        let allowed = decided.get(node.serverId)
        if (allowed === undefined) {
          allowed = await this.#h.allowed(this.#h.store, 'node.list', caller, {
            kind: 'server',
            serverId: node.serverId,
          })
          decided.set(node.serverId, allowed)
        }
        if (allowed) items.push(NodeSchema.parse(node))
        after = node.id
        const more = page.more || node !== page.items[page.items.length - 1]
        if (items.length === request.limit || scanned === SCAN_LIMIT) {
          return { items, nextCursor: more ? encodeCursor(node.id) : null }
        }
      }
      if (!page.more) return { items, nextCursor: null }
    }
  }

  /**
   * `node.job.list` (Wave 8): recent jobs of one node, newest first, by a
   * keyset on the job id. A job is shown by its capability, state, times and
   * reported outcome; the envelope, the arguments, the completion and any
   * signature stay in the store.
   */
  async jobs(
    caller: CallerLike,
    nodeId: string,
    request: PageRequest,
  ): Promise<{ items: NodeJob[]; nextCursor: string | null }> {
    const subject = await this.#nodeSubject(nodeId)
    await this.#h.authorize(this.#h.store, 'node.job.list', caller, subject)
    const page = await listNodeJobs(this.#h.store, nodeId, {
      after: decodeCursor(request.cursor),
      limit: request.limit,
    })
    return {
      items: page.items.map((j) => NodeJobSchema.parse(j)),
      nextCursor: page.more && page.last !== null ? encodeCursor(page.last) : null,
    }
  }

  /**
   * `node.certificate.list` (Wave 8): the agent PKI's and the PostgreSQL CA's
   * certificates by their facts, and the expiry of each node's certificate.
   * Installation-wide, so a restricted grant is refused. What is not known
   * is part of the answer: the gateway's TLS certificate lives in the
   * gateway's memory, and an external cluster's server certificate is never
   * probed.
   */
  async certificates(caller: CallerLike): Promise<NodeCertificates> {
    await this.#h.authorize(this.#h.store, 'node.certificate.list', caller, {
      kind: 'installation',
    })
    const read = await readCertificates(this.#h.store)
    return NodeCertificatesSchema.parse({
      authorities: read.authorities,
      notRecorded: read.notRecorded.map((n) => ({ role: n.role, reason: 'not_initialized' })),
      nodes: read.nodes,
      nodesTruncated: read.nodesTruncated,
      notKnown: [
        { subject: 'gateway_leaf', reason: 'in_memory_only' },
        { subject: 'external_server_certificates', reason: 'not_probed' },
      ],
      source: 'live',
      observedAt: new Date(this.#h.clock.nowMs()).toISOString(),
    })
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

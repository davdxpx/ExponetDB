import type { AccessRole } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import {
  type CircuitBreaker,
  type ConnectionBudget,
  ROLE_NAMES,
  readMarker,
  type SessionGuards,
  type SessionLimits,
  TargetError,
  TargetSession,
} from '@exponetdb/postgres'
import { type Consumer, type Keyring, readSecret } from '@exponetdb/secrets'
import { conflict, RegistryError } from './errors.ts'
import { activeCredential, getCluster, listEndpoints } from './reads.ts'
import {
  type ClusterRecord,
  type EndpointRecord,
  isObserved,
  type TargetRecord,
} from './records.ts'

/**
 * Target resolution to a verified session ([registry.md §1](../../../exponetdb-docs/02-control-plane/registry.md#1-resolution)).
 * Everything comes from the registry, never from a request: the current
 * placement names the database and the cluster, the cluster names its CA
 * bundle and its pinned `system_identifier`, the role names the endpoint
 * preference and the credential, and the credential names one secret
 * version, decrypted from the consumer table the process may read:
 *
 * - `serve` decrypts observer secrets only (it cannot read the worker's
 *   ciphertext table at all, se1); every other role is the worker's;
 * - observer and reader use direct endpoints (private before public);
 *   verifier, operator and migrator too. A cluster without an active direct
 *   endpoint (a hosted provider reachable through its session pooler only,
 *   ADR-0039 §4) serves observer sessions through its session-mode poolers
 *   and refuses every other role (`cluster_pooler_only`). A transaction-mode pooler is probed by health
 *   per endpoint but never used for a session here. A local socket only
 *   makes sense on a node and is not used for external clusters;
 * - the login through a pooler endpoint with a login suffix is
 *   `exponetdb_<role>.<suffix>` (the pooler routes by it); the session
 *   guards check the server side as on any other path;
 * - the next endpoint is tried only when one does not answer; a TLS or
 *   credential failure stops (it would fail the same way, or worse, succeed
 *   against something else).
 */
export interface ConnectorOptions {
  readonly keyring: Keyring
  readonly process: 'serve' | 'worker'
  /** This installation: a write-capable target session must find its marker. */
  readonly installationId: string
  readonly budget?: ConnectionBudget
  readonly breaker?: CircuitBreaker
  readonly limits?: Partial<SessionLimits>
}

export interface OpenedSession {
  readonly session: TargetSession
  readonly endpoint: EndpointRecord
  readonly cluster: ClusterRecord
}

export interface SessionRequest {
  readonly clusterId: string
  readonly database: string
  readonly role: AccessRole
  /** Shown as `application_name` (`exponetdb/<purpose>`); ids and paths only, never a secret. */
  readonly purpose: string
  /**
   * `pinned` (default): the cluster must be active and the session must
   * reach its pinned `system_identifier`. `unpinned`: only while confirming
   * a pending cluster, where the identifier is what is being read.
   */
  readonly identity?: 'pinned' | 'unpinned'
  /** Use exactly this endpoint (health probes, confirmation of a chosen path). */
  readonly endpointId?: string
  /** A credential that is not active yet (its verification). */
  readonly credential?: { readonly secretId: string; readonly version: number }
  /** `simple` for health probe sessions (see `OpenOptions.guardProtocol`). */
  readonly guardProtocol?: 'simple' | 'extended'
}

const DIRECT_ORDER: Readonly<Record<string, number>> = { private: 0, public: 1, local_socket: 2 }

export function directEndpoints(
  endpoints: readonly EndpointRecord[],
  cluster: Pick<ClusterRecord, 'managementMode'>,
): EndpointRecord[] {
  return endpoints
    .filter(
      (e) =>
        e.state === 'active' &&
        e.kind !== 'pooler' &&
        (e.kind !== 'local_socket' || cluster.managementMode === 'agent'),
    )
    .sort(
      (a, b) =>
        (DIRECT_ORDER[a.kind] ?? 9) - (DIRECT_ORDER[b.kind] ?? 9) ||
        (a.endpointId < b.endpointId ? -1 : 1),
    )
}

/**
 * The endpoints a session ExponetDB opens itself may use, in order (ADR-0039 §4): the direct
 * ones; only when the cluster has none, its session-mode poolers, and those for the observer
 * only. Never a transaction-mode pooler.
 */
export function sessionEndpoints(
  endpoints: readonly EndpointRecord[],
  cluster: Pick<ClusterRecord, 'managementMode'>,
  role: AccessRole,
): EndpointRecord[] {
  const direct = directEndpoints(endpoints, cluster)
  if (direct.length > 0 || role !== 'observer') return direct
  return sessionPoolers(endpoints)
}

function sessionPoolers(endpoints: readonly EndpointRecord[]): EndpointRecord[] {
  return endpoints
    .filter((e) => e.state === 'active' && e.kind === 'pooler' && e.poolerMode === 'session')
    .sort((a, b) => (a.endpointId < b.endpointId ? -1 : 1))
}

/** The login name of a role through an endpoint: `exponetdb_<role>[.<suffix>]` (ADR-0039 §4). */
export function loginName(
  role: AccessRole,
  endpoint: Pick<EndpointRecord, 'loginSuffix'> | { readonly loginSuffix?: string | null },
): string {
  const suffix = endpoint.loginSuffix ?? null
  return suffix === null ? ROLE_NAMES[role] : `${ROLE_NAMES[role]}.${suffix}`
}

export function consumerOf(role: AccessRole): Consumer {
  return role === 'observer' ? 'observer' : 'worker'
}

export class Connector {
  readonly #q: Queryable
  readonly #options: ConnectorOptions

  constructor(controlStore: Queryable, options: ConnectorOptions) {
    this.#q = controlStore
    this.#options = options
  }

  get process(): 'serve' | 'worker' {
    return this.#options.process
  }

  async #password(
    clusterId: string,
    role: AccessRole,
    credential: SessionRequest['credential'],
  ): Promise<string> {
    if (this.#options.process === 'serve' && role !== 'observer') {
      // serve never holds another role's secret; the database grants refuse it too.
      throw new RegistryError('PERMISSION_DENIED')
    }
    let ref = credential
    if (ref === undefined) {
      const active = await activeCredential(this.#q, clusterId, role)
      if (active === undefined) {
        throw conflict(role === 'observer' ? 'observer_credential_missing' : 'credential_missing')
      }
      ref = { secretId: active.secretId, version: active.secretVersion }
    }
    if (!/^sec_/.test(ref.secretId)) {
      throw new RegistryError('INTERNAL')
    }
    const plaintext = await readSecret(this.#q, this.#options.keyring, {
      secretId: ref.secretId as Parameters<typeof readSecret>[2]['secretId'],
      consumer: consumerOf(role),
      version: ref.version,
    })
    try {
      return plaintext.toString('utf8')
    } finally {
      plaintext.fill(0)
    }
  }

  /** Opens a guarded session as `role` on a database of a cluster. */
  async open(request: SessionRequest): Promise<OpenedSession> {
    const cluster = await getCluster(this.#q, request.clusterId)
    if (cluster === undefined) {
      throw new RegistryError('NOT_FOUND')
    }
    const pinned = (request.identity ?? 'pinned') === 'pinned'
    if (cluster.state === 'retired' || (pinned && cluster.state !== 'active')) {
      throw conflict(cluster.state === 'retired' ? 'cluster_retired' : 'cluster_not_confirmed')
    }
    // Without the pinned identifier only the observer may read, and only what confirmation
    // needs: never on a confirmed cluster, never another role (fail closed on a misuse).
    if (!pinned && (request.role !== 'observer' || cluster.state !== 'pending')) {
      throw new RegistryError('INTERNAL')
    }
    const all = await listEndpoints(this.#q, cluster.clusterId, 'active')
    const candidates =
      request.endpointId === undefined
        ? sessionEndpoints(all, cluster, request.role)
        : all.filter((e) => e.endpointId === request.endpointId)
    if (candidates.length === 0) {
      throw conflict(
        request.endpointId === undefined &&
          directEndpoints(all, cluster).length === 0 &&
          sessionPoolers(all).length > 0
          ? 'cluster_pooler_only'
          : 'no_active_endpoint',
      )
    }
    // A pooler is probed and read through by the observer; never a session that writes,
    // verifies or signals (postgres-adapter.md §3).
    if (
      request.role !== 'observer' &&
      request.role !== 'reader' &&
      candidates.some((e) => e.kind === 'pooler')
    ) {
      throw new RegistryError('INTERNAL')
    }
    const password = await this.#password(cluster.clusterId, request.role, request.credential)
    const guards: SessionGuards = {
      database: request.database,
      ...(pinned && cluster.systemIdentifier !== null
        ? { systemIdentifier: cluster.systemIdentifier }
        : {}),
    }
    let last: unknown
    for (const endpoint of candidates) {
      try {
        const session = await TargetSession.open(
          {
            endpoint: {
              host: endpoint.host,
              port: endpoint.port,
              tlsServerName: endpoint.tlsServerName,
              caPem: cluster.caBundle,
            },
            database: request.database,
            role: request.role,
            user: loginName(request.role, endpoint),
            password,
            applicationName: `exponetdb/${request.purpose}`,
          },
          {
            guards,
            ...(request.guardProtocol === undefined
              ? {}
              : { guardProtocol: request.guardProtocol }),
            // A pooler may drop the startup options: the session sets them again (ADR-0039).
            ...(endpoint.kind === 'pooler' ? { reapplySettings: true } : {}),
            ...(this.#options.limits === undefined ? {} : { limits: this.#options.limits }),
            ...(this.#options.budget === undefined
              ? {}
              : { budget: { pool: this.#options.budget, key: cluster.clusterId } }),
            ...(this.#options.breaker === undefined
              ? {}
              : { breaker: { breaker: this.#options.breaker, key: endpoint.endpointId } }),
          },
        )
        await requireSessionUser(session, request.role)
        return { session, endpoint, cluster }
      } catch (error) {
        last = error
        if (!(error instanceof TargetError) || error.code !== 'TARGET_UNAVAILABLE') {
          throw error
        }
      }
    }
    throw last
  }

  /**
   * The system identifier an address answers with, read as the cluster's observer before the
   * address is registered as an endpoint (VC-074). The address is not in the registry yet, so
   * the session is not pinned; the caller compares the identifier with the cluster's.
   */
  async probeAddress(
    clusterId: string,
    address: {
      readonly host: string
      readonly port: number
      readonly tlsServerName: string
      /** The login suffix of a pooler address (ADR-0039 §4). */
      readonly loginSuffix?: string | null
      readonly kind?: string
    },
    purpose: string,
  ): Promise<string> {
    const cluster = await getCluster(this.#q, clusterId)
    if (cluster === undefined) {
      throw new RegistryError('NOT_FOUND')
    }
    if (cluster.state === 'retired') {
      throw conflict('cluster_retired')
    }
    const password = await this.#password(cluster.clusterId, 'observer', undefined)
    const session = await TargetSession.open(
      {
        endpoint: {
          host: address.host,
          port: address.port,
          tlsServerName: address.tlsServerName,
          caPem: cluster.caBundle,
        },
        database: 'postgres',
        role: 'observer',
        user: loginName('observer', address),
        password,
        applicationName: `exponetdb/${purpose}`,
      },
      {
        guards: { database: 'postgres' },
        ...(address.kind === 'pooler' ? { reapplySettings: true } : {}),
        ...(this.#options.limits === undefined ? {} : { limits: this.#options.limits }),
      },
    )
    try {
      await requireSessionUser(session, 'observer')
      return session.facts.systemIdentifier
    } finally {
      await session.close()
    }
  }

  /** A session on a target's current placement. */
  async forTarget(
    target: TargetRecord,
    role: AccessRole,
    purpose: string,
    options: { readonly endpointId?: string } = {},
  ): Promise<OpenedSession> {
    const placement = target.placement
    if (placement === null) {
      throw new RegistryError('TARGET_UNAVAILABLE')
    }
    if (isObserved(target) && role !== 'observer') {
      // ADR-0039 §3: an observed target is read as the observer only; nothing writes to it,
      // reads its rows or verifies on it.
      throw new RegistryError('TARGET_OBSERVED_ONLY')
    }
    if ((role === 'operator' || role === 'migrator') && target.state !== 'active') {
      // Writes stop while a target is suspended (registry.md §3); registration and
      // resumption open their own sessions and prove the marker themselves.
      throw new RegistryError('TARGET_SUSPENDED', {
        reason:
          target.state === 'suspended' && target.stateReason !== null
            ? target.stateReason
            : 'administrator',
      })
    }
    const opened = await this.open({
      clusterId: placement.clusterId,
      database: placement.databaseName,
      role,
      purpose,
      ...(options.endpointId === undefined ? {} : { endpointId: options.endpointId }),
    })
    if (isObserved(target)) {
      // ADR-0039 §2: an observed target has no marker; its database is the one whose oid was
      // recorded at registration. Every reader checks it again; this is the connector's own check.
      const recorded = placement.databaseOid
      const observed = opened.session.facts.databaseOid
      if (recorded === null || observed !== recorded) {
        await opened.session.close()
        throw new RegistryError(
          'TARGET_IDENTITY_MISMATCH',
          recorded === null
            ? undefined
            : { reason: 'database_oid', recordedOid: recorded, observedOid: observed },
        )
      }
    }
    if (role === 'operator' || role === 'migrator') {
      // C-27: a session that can write or signal is handed out only after the
      // database proves it is this target at this generation of this installation.
      try {
        await requireMarker(opened.session, {
          installationId: this.#options.installationId,
          targetId: target.targetId,
          generation: target.generation,
        })
      } catch (error) {
        await opened.session.close()
        throw error
      }
    }
    return opened
  }
}

/**
 * The server-side session role is ExponetDB's role for the path (ADR-0039 §4): a pooler maps
 * `exponetdb_<role>.<suffix>` to `exponetdb_<role>`, and a mapping to any other role (another
 * tenant's, a role with more rights) is refused before the session is used.
 */
async function requireSessionUser(session: TargetSession, role: AccessRole): Promise<void> {
  if (session.facts.user !== ROLE_NAMES[role]) {
    await session.close()
    throw new TargetError('TARGET_CREDENTIAL_INVALID', 'session_user')
  }
}

/** The identity marker must name this installation, target and generation. */
async function requireMarker(
  session: TargetSession,
  expected: {
    readonly installationId: string
    readonly targetId: string
    readonly generation: number
  },
): Promise<void> {
  const marker = await readMarker(session)
  if (marker.status !== 'present') {
    throw new TargetError('TARGET_IDENTITY_MISMATCH', 'marker_missing')
  }
  const m = marker.marker
  if (
    m.installationId !== expected.installationId ||
    m.targetId !== expected.targetId ||
    m.generation !== expected.generation
  ) {
    throw new TargetError('TARGET_IDENTITY_MISMATCH', 'marker_mismatch')
  }
}

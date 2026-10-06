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
import type { ClusterRecord, EndpointRecord, TargetRecord } from './records.ts'

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
 *   verifier, operator and migrator too. Poolers are probed by health per
 *   endpoint but never used for a session here. A local socket only makes
 *   sense on a node and is not used for external clusters;
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
        ? directEndpoints(all, cluster)
        : all.filter((e) => e.endpointId === request.endpointId)
    if (candidates.length === 0) {
      throw conflict('no_active_endpoint')
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
            user: ROLE_NAMES[request.role],
            password,
            applicationName: `exponetdb/${request.purpose}`,
          },
          {
            guards,
            ...(request.guardProtocol === undefined
              ? {}
              : { guardProtocol: request.guardProtocol }),
            ...(this.#options.limits === undefined ? {} : { limits: this.#options.limits }),
            ...(this.#options.budget === undefined
              ? {}
              : { budget: { pool: this.#options.budget, key: cluster.clusterId } }),
            ...(this.#options.breaker === undefined
              ? {}
              : { breaker: { breaker: this.#options.breaker, key: endpoint.endpointId } }),
          },
        )
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
    const opened = await this.open({
      clusterId: placement.clusterId,
      database: placement.databaseName,
      role,
      purpose,
      ...(options.endpointId === undefined ? {} : { endpointId: options.endpointId }),
    })
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

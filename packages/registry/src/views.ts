import type {
  Cluster,
  CredentialView,
  DatabaseView,
  EndpointView,
  Environment,
  HealthSummary,
  Product,
  Project,
  Server,
  Target,
  TargetSummary,
} from '@exponetdb/contracts'
import { type EntityId, type IdPrefix, InvariantError, isId } from '@exponetdb/kernel'
import type {
  ClusterRecord,
  CredentialRecord,
  DatabaseRecord,
  EndpointRecord,
  EnvironmentRecord,
  ProductRecord,
  ProjectRecord,
  ServerRecord,
  TargetRecord,
} from './records.ts'

/**
 * Purpose-built response views (resources.md, order §127). Every field is
 * chosen here; a record is never serialized as it is. The CA bundle, the
 * secret reference of a credential, connection options and database
 * addresses never appear; endpoint addresses appear only in the
 * administrative endpoint view, which `registry.manage` alone reads.
 */
export function brand<P extends IdPrefix>(prefix: P, value: string): EntityId<P> {
  if (!isId(prefix, value)) {
    throw new InvariantError(`a stored ${prefix}_ id is canonical`)
  }
  return value
}

const maybe = <P extends IdPrefix>(prefix: P, value: string | null): EntityId<P> | null =>
  value === null ? null : brand(prefix, value)

export function productView(p: ProductRecord): Product {
  return { id: brand('prd', p.productId), slug: p.slug, displayName: p.displayName }
}

export function environmentView(e: EnvironmentRecord): Environment {
  return {
    id: brand('env', e.environmentId),
    productId: brand('prd', e.productId),
    slug: e.slug,
    displayName: e.displayName,
    tier: e.tier,
    evidenceFrom: e.evidenceFromSlug,
    rank: e.rank,
    revision: e.revision,
  }
}

export function projectView(p: ProjectRecord): Project {
  return {
    id: brand('prj', p.projectId),
    productId: brand('prd', p.productId),
    slug: p.slug,
    path: `${p.productSlug}/${p.slug}`,
    displayName: p.displayName,
    evidenceOverride: { ...p.evidenceOverride },
    managedScope: {
      includeSchemas:
        p.managedScope.includeSchemas === null ? null : [...p.managedScope.includeSchemas],
      excludeSchemas: [...p.managedScope.excludeSchemas],
    },
    revision: p.revision,
  }
}

export function serverView(s: ServerRecord): Server {
  return {
    id: brand('srv', s.serverId),
    displayName: s.displayName,
    provider: s.provider,
    location: s.location,
    derivedTier: s.derivedTier,
    // External servers have no node agent before Wave 5: nothing is reported.
    observedFacts: null,
  }
}

/** `160004` → `16.4`. */
export function postgresVersion(versionNum: number | null): string | null {
  if (versionNum === null) return null
  return `${Math.floor(versionNum / 10_000)}.${versionNum % 10_000}`
}

export function clusterView(c: ClusterRecord, health: HealthSummary | null = null): Cluster {
  return {
    id: brand('cls', c.clusterId),
    displayName: c.displayName,
    serverId: maybe('srv', c.serverId),
    managementMode: c.managementMode,
    state: c.state,
    confirmedAt: c.confirmedAt,
    postgresVersion: postgresVersion(c.serverVersionNum),
    systemIdentifier: c.systemIdentifier,
    derivedTier: c.derivedTier,
    declaredTier: c.declaredTier,
    health,
  }
}

export function targetSummaryView(t: TargetRecord, health: HealthSummary | null): TargetSummary {
  return {
    id: brand('tgt', t.targetId),
    path: t.path,
    productId: brand('prd', t.productId),
    projectId: brand('prj', t.projectId),
    environmentId: brand('env', t.environmentId),
    tier: t.tier,
    state: t.state,
    generation: t.generation,
    health,
  }
}

export function targetView(
  t: TargetRecord,
  health: HealthSummary | null,
  openFindingCount: number,
): Target {
  const p = t.placement
  return {
    ...targetSummaryView(t, health),
    environment: { slug: t.environmentSlug, tier: t.tier },
    placement:
      p === null
        ? null
        : {
            clusterId: brand('cls', p.clusterId),
            generation: p.generation,
            since: p.validFrom,
            serverName: p.serverName,
            clusterName: p.clusterName,
            managementMode: p.managementMode,
            postgresVersion: postgresVersion(p.serverVersionNum),
          },
    // The ledger mirror arrives with the migration engine (Wave 6).
    ledger: null,
    openFindingCount,
  }
}

export function endpointView(e: EndpointRecord): EndpointView {
  return {
    id: brand('end', e.endpointId),
    clusterId: brand('cls', e.clusterId),
    kind: e.kind,
    poolerMode: e.poolerMode,
    host: e.host,
    port: e.port,
    tlsServerName: e.tlsServerName,
    label: e.label,
    state: e.state,
    createdAt: e.createdAt,
    retiredAt: e.retiredAt,
  }
}

export function databaseView(d: DatabaseRecord): DatabaseView {
  return {
    id: brand('dbs', d.databaseId),
    clusterId: brand('cls', d.clusterId),
    name: d.name,
    state: d.state,
    observed:
      d.observedAt === null
        ? null
        : {
            owner: d.observedOwner ?? '',
            encoding: d.observedEncoding ?? '',
            collation: d.observedCollation ?? '',
            observedAt: d.observedAt,
          },
    placement:
      d.placedTargetId === null || d.placedGeneration === null
        ? null
        : { targetId: brand('tgt', d.placedTargetId), generation: d.placedGeneration },
    createdAt: d.createdAt,
  }
}

export function credentialView(c: CredentialRecord): CredentialView {
  return {
    id: brand('crd', c.credentialId),
    clusterId: brand('cls', c.clusterId),
    accessRole: c.accessRole,
    roleName: c.roleName,
    state: c.state,
    version: c.secretVersion,
    submittedAt: c.submittedAt,
    submittedBy: brand('idn', c.submittedBy),
    verifiedAt: c.verifiedAt,
    failureCode: c.failureCode,
    stateChangedAt: c.stateChangedAt,
  }
}

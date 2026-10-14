import type { AccessRole, Cluster, DatabaseView, EndpointView } from '@exponetdb/sdk/operations'
import {
  Button,
  Input,
  Label,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  Admonition,
  KeyValueList,
  NotPermittedState,
  ObservedTime,
  ReadableView,
  TierChip,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { targetHref } from '../../shell/navigation.ts'
import { NotFoundPage } from '../../shell/not-found.tsx'
import { ACCESS_ROLES } from '../credentials/keys.ts'
import { usePlanRequest } from './actions.ts'
import { DesiredRolesForm, ObservedRoles, RoleVerifierForm } from './cluster-roles.tsx'
import { ClusterHealth, DeclaredTier } from './clusters-page.tsx'
import {
  clusterDatabasesQuery,
  clusterEndpointsQuery,
  clusterQuery,
  INFRA_PAGE_LIMIT,
  isClusterId,
  nodesQuery,
} from './keys.ts'
import { credentialsPath, nodePath, serverPath, servingNode } from './model.ts'
import { InfraPage, InfraSection, NodeStateBadge, ObjectLink } from './parts.tsx'

/**
 * `/infrastructure/clusters/<cls_…>` (information-architecture.md §2.3):
 * one cluster (`GET /clusters/{id}`) with its placements (databases and the
 * targets on them), its endpoints (addresses: `registry.manage` only, as the
 * server decides), the declared intended tier ("Declare tier", OD-22), roles
 * as cluster-wide desired state, a role's password as a verifier, the
 * hand-off of ExponetDB's own credentials, and the confirmation of a pending
 * cluster. Every change is a plan reviewed on `/changes/plans/<id>`.
 */
export function ClusterDetailPage({ clusterId }: { readonly clusterId: string }): ReactNode {
  if (!isClusterId(clusterId)) return <NotFoundPage />
  return <ClusterDetail clusterId={clusterId} />
}

/**
 * Production unless the cluster is declared `nonprod` and its databases do
 * not make it production: an undeclared cluster is treated as production
 * (registry.md §4.1, fail closed).
 */
export function clusterTier(cluster: Cluster): 'prod' | 'nonprod' {
  return (cluster.declaredTier ?? null) === 'nonprod' && cluster.derivedTier !== 'prod'
    ? 'nonprod'
    : 'prod'
}

function ClusterDetail({ clusterId }: { readonly clusterId: string }): ReactNode {
  const { client } = useApi()
  const cluster = useQuery(clusterQuery(client, clusterId))
  if (cluster.isError && classifyFailure(cluster.error).kind === 'not_found') {
    return <NotFoundPage />
  }
  const value = cluster.data
  const tier = value === undefined ? 'prod' : clusterTier(value)
  return (
    <InfraPage
      title={
        value === undefined ? (
          t('infra.cluster.title')
        ) : (
          <UntrustedName name={value.displayName} label={t('infra.column.name')} />
        )
      }
      description={t('infra.cluster.description')}
      production={value !== undefined && tier === 'prod'}
    >
      <InfraSection id="cluster-overview" title={t('infra.cluster.overview.title')}>
        <ReadableView
          readable={toReadable(cluster)}
          what={t('infra.cluster.what')}
          onRetry={() => void cluster.refetch()}
          onRefresh={() => void cluster.refetch()}
          busy={cluster.isFetching}
          headingLevel={3}
          ready={(c) => <ClusterFacts cluster={c} />}
        />
      </InfraSection>
      {value === undefined ? null : <ClusterSections cluster={value} tier={tier} />}
    </InfraPage>
  )
}

function ClusterFacts({ cluster }: { readonly cluster: Cluster }): ReactNode {
  return (
    <KeyValueList
      items={[
        {
          id: 'id',
          label: t('infra.column.id'),
          value: <code className="font-mono text-xs">{cluster.id}</code>,
        },
        {
          id: 'mode',
          label: t('infra.clusters.column.mode'),
          value: t(`infra.cluster.mode.${cluster.managementMode}`),
        },
        {
          id: 'state',
          label: t('infra.clusters.column.state'),
          value: (
            <span>
              {t(`infra.cluster.state.${cluster.state}`)}
              {cluster.confirmedAt === null ? null : (
                <>
                  {' · '}
                  {t('infra.cluster.confirmedAt')}{' '}
                  <ObservedTime observedAt={cluster.confirmedAt} withDate />
                </>
              )}
            </span>
          ),
        },
        {
          id: 'version',
          label: t('infra.clusters.column.version'),
          value:
            cluster.postgresVersion === null ? (
              t('infra.value.notKnown')
            ) : (
              <UntrustedName
                name={cluster.postgresVersion}
                mono
                label={t('infra.clusters.column.version')}
              />
            ),
        },
        {
          id: 'system-identifier',
          label: t('infra.cluster.systemIdentifier'),
          value:
            cluster.systemIdentifier === null ? (
              t('infra.cluster.systemIdentifier.none')
            ) : (
              <code className="font-mono text-xs">{cluster.systemIdentifier}</code>
            ),
        },
        {
          id: 'server',
          label: t('infra.clusters.column.server'),
          value:
            cluster.serverId === null ? (
              t('infra.value.none')
            ) : (
              <ObjectLink
                href={serverPath(cluster.serverId)}
                text={cluster.serverId}
                label={t('infra.clusters.column.server')}
              />
            ),
        },
        {
          id: 'derived-tier',
          label: t('infra.clusters.column.derived'),
          value:
            cluster.derivedTier === null ? (
              t('infra.tier.noneDerived')
            ) : (
              <TierChip tier={cluster.derivedTier} />
            ),
        },
        {
          id: 'declared-tier',
          label: t('infra.clusters.column.declared'),
          value: <DeclaredTier cluster={cluster} />,
        },
        {
          id: 'health',
          label: t('infra.clusters.column.health'),
          value: <ClusterHealth cluster={cluster} />,
        },
      ]}
    />
  )
}

function ClusterSections({
  cluster,
  tier,
}: {
  readonly cluster: Cluster
  readonly tier: 'prod' | 'nonprod'
}): ReactNode {
  return (
    <>
      {cluster.state === 'pending' ? (
        <InfraSection
          id="cluster-confirm"
          title={t('infra.cluster.confirm.title')}
          description={t('infra.cluster.confirm.description')}
        >
          <ConfirmClusterForm cluster={cluster} />
        </InfraSection>
      ) : null}
      <InfraSection
        id="cluster-tier"
        title={t('infra.cluster.tier.title')}
        description={t('infra.cluster.tier.description')}
      >
        <DeclareTierForm cluster={cluster} />
      </InfraSection>
      <InfraSection id="cluster-placements" title={t('infra.cluster.placements.title')}>
        <Placements cluster={cluster} />
      </InfraSection>
      <InfraSection
        id="cluster-endpoints"
        title={t('infra.cluster.endpoints.title')}
        description={t('infra.cluster.endpoints.description')}
      >
        <Endpoints cluster={cluster} />
      </InfraSection>
      <InfraSection
        id="cluster-roles"
        title={t('infra.roles.title')}
        description={t('infra.roles.description')}
      >
        <RolesSection cluster={cluster} tier={tier} />
      </InfraSection>
      <InfraSection
        id="cluster-credentials"
        title={t('infra.cluster.credentials.title')}
        description={t('infra.cluster.credentials.description')}
      >
        <CredentialsHandOff cluster={cluster} />
      </InfraSection>
    </>
  )
}

function DeclareTierForm({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const request = usePlanRequest()
  const selectId = useId()
  const noteId = useId()
  const current = cluster.declaredTier ?? null
  const [choice, setChoice] = useState<'prod' | 'nonprod'>(
    current === 'nonprod' ? 'prod' : 'nonprod',
  )
  const [alert, setAlert] = useState('')
  const [busy, setBusy] = useState(false)
  if (cluster.state === 'retired') {
    return <p className="text-sm text-foreground-light">{t('infra.cluster.tier.retired')}</p>
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) return
    if (choice === current) {
      setAlert(t('infra.cluster.tier.same'))
      return
    }
    setAlert('')
    setBusy(true)
    request((client) =>
      client.operation('planClusterDeclaredTier', {
        params: { clusterId: cluster.id },
        body: { declaredTier: choice },
      }),
    )
      .catch((error: unknown) => setAlert(describeError(error)))
      .finally(() => setBusy(false))
  }
  return (
    <form
      id="declare-tier-form"
      className="flex max-w-md flex-col gap-3"
      onSubmit={submit}
      noValidate
    >
      <p className="text-sm">
        {t('infra.cluster.tier.current')} <DeclaredTier cluster={cluster} />
      </p>
      <Admonition
        type="warning"
        title={t('infra.cluster.tier.authority.title')}
        childProps={{ description: { id: noteId } }}
        description={t('infra.cluster.tier.authority.body')}
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={selectId}>{t('infra.cluster.tier.choice')}</Label>
        <select
          id={selectId}
          name="declaredTier"
          value={choice}
          disabled={busy}
          aria-describedby={noteId}
          onChange={(event) => setChoice(event.currentTarget.value === 'prod' ? 'prod' : 'nonprod')}
          className="h-[34px] rounded-md border border-control bg-control px-2 text-sm text-foreground focus-ring"
        >
          <option value="prod">{t('infra.tier.prod')}</option>
          <option value="nonprod">{t('infra.tier.nonprod')}</option>
        </select>
      </div>
      <p className="alert text-sm text-destructive" role="alert">
        {alert}
      </p>
      <div>
        <Button id="declare-tier" type="submit" variant="primary" size="small" loading={busy}>
          {t('infra.cluster.tier.submit')}
        </Button>
      </div>
    </form>
  )
}

function ConfirmClusterForm({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const request = usePlanRequest()
  const inputId = useId()
  const [alert, setAlert] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) return
    const systemIdentifier = String(
      new FormData(event.currentTarget).get('systemIdentifier') ?? '',
    ).trim()
    if (systemIdentifier !== '' && !/^[0-9]{1,20}$/.test(systemIdentifier)) {
      setAlert(t('infra.cluster.confirm.invalid'))
      return
    }
    setAlert('')
    setBusy(true)
    request((client) =>
      client.operation('planClusterConfirmation', {
        params: { clusterId: cluster.id },
        body: systemIdentifier === '' ? {} : { systemIdentifier },
      }),
    )
      .catch((error: unknown) => setAlert(describeError(error)))
      .finally(() => setBusy(false))
  }
  return (
    <form
      id="confirm-cluster-form"
      className="flex max-w-md flex-col gap-3"
      onSubmit={submit}
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={inputId}>{t('infra.cluster.confirm.systemIdentifier')}</Label>
        <Input
          id={inputId}
          name="systemIdentifier"
          inputMode="numeric"
          autoComplete="off"
          maxLength={20}
          disabled={busy}
        />
      </div>
      <p className="alert text-sm text-destructive" role="alert">
        {alert}
      </p>
      <div>
        <Button type="submit" variant="default" size="small" loading={busy}>
          {t('infra.cluster.confirm.submit')}
        </Button>
      </div>
    </form>
  )
}

function Placements({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const { client } = useApi()
  const databases = useQuery(clusterDatabasesQuery(client, cluster.id))
  const targets = useQuery({
    queryKey: ['infrastructure', 'targets'],
    queryFn: ({ signal }) =>
      client.operation('listTargets', { query: { limit: INFRA_PAGE_LIMIT }, signal }),
  })
  if (databases.isError && classifyFailure(databases.error).kind === 'not_permitted') {
    return (
      <NotPermittedState
        what={t('infra.cluster.placements.what')}
        permission="registry.manage"
        headingLevel={3}
      />
    )
  }
  const paths = new Map((targets.data?.items ?? []).map((target) => [target.id, target]))
  return (
    <ReadableView
      readable={toReadable(databases, {
        missing: (v) => (v.truncated ? [t('infra.cluster.placements.truncated')] : undefined),
      })}
      what={t('infra.cluster.placements.what')}
      onRetry={() => void databases.refetch()}
      onRefresh={() => void databases.refetch()}
      busy={databases.isFetching}
      headingLevel={3}
      empty={{
        isEmpty: (v) => v.items.length === 0,
        content: (
          <p className="text-sm text-foreground-light">{t('infra.cluster.placements.none')}</p>
        ),
      }}
      ready={(v) => (
        <DatabaseTable
          databases={v.items}
          target={(id) => paths.get(id)}
          targetsFailed={targets.isError}
        />
      )}
    />
  )
}

function DatabaseTable({
  databases,
  target,
  targetsFailed,
}: {
  readonly databases: readonly DatabaseView[]
  readonly target: (id: string) => { readonly path: string; readonly tier: string } | undefined
  readonly targetsFailed: boolean
}): ReactNode {
  const Link = useLinkComponent()
  return (
    <>
      {targetsFailed ? (
        <p className="text-sm text-warning-600">{t('infra.cluster.placements.targetsFailed')}</p>
      ) : null}
      <Table>
        <TableCaption className="sr-only">{t('infra.cluster.placements.what')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('infra.cluster.placements.database')}</TableHead>
            <TableHead scope="col">{t('infra.cluster.placements.state')}</TableHead>
            <TableHead scope="col">{t('infra.cluster.placements.target')}</TableHead>
            <TableHead scope="col">{t('infra.cluster.placements.owner')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {databases.map((database) => {
            const placed = database.placement
            const known = placed === null ? undefined : target(placed.targetId)
            const segments = known?.path.split('/')
            const href =
              segments?.length === 3
                ? targetHref({
                    product: segments[0] ?? '',
                    project: segments[1] ?? '',
                    environment: segments[2] ?? '',
                  })
                : undefined
            return (
              <TableRow key={database.id} data-database={database.id}>
                <TableCell>
                  <UntrustedName
                    name={database.name}
                    mono
                    label={t('infra.cluster.placements.database')}
                  />
                </TableCell>
                <TableCell>{t(`infra.cluster.database.${database.state}`)}</TableCell>
                <TableCell>
                  {placed === null ? (
                    t('infra.cluster.placements.unplaced')
                  ) : known !== undefined && href !== undefined ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <Link
                        href={href}
                        className="font-mono text-xs text-primary underline focus-ring"
                      >
                        {known.path}
                      </Link>
                      <TierChip tier={known.tier} />
                      <span className="text-xs text-foreground-light">
                        {t('infra.cluster.placements.generation', {
                          generation: placed.generation,
                        })}
                      </span>
                    </span>
                  ) : (
                    <code className="font-mono text-xs">{placed.targetId}</code>
                  )}
                </TableCell>
                <TableCell>
                  {database.observed === null ? (
                    t('infra.value.notKnown')
                  ) : (
                    <span className="text-xs">
                      <UntrustedName
                        name={database.observed.owner}
                        mono
                        label={t('infra.cluster.placements.owner')}
                      />{' '}
                      <ObservedTime observedAt={database.observed.observedAt} withDate />
                    </span>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </>
  )
}

function Endpoints({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const { client } = useApi()
  const endpoints = useQuery(clusterEndpointsQuery(client, cluster.id))
  if (endpoints.isError && classifyFailure(endpoints.error).kind === 'not_permitted') {
    return (
      <NotPermittedState
        what={t('infra.cluster.endpoints.what')}
        permission="registry.manage"
        headingLevel={3}
      />
    )
  }
  return (
    <ReadableView
      readable={toReadable(endpoints, {
        missing: (v) => (v.truncated ? [t('infra.cluster.endpoints.truncated')] : undefined),
      })}
      what={t('infra.cluster.endpoints.what')}
      onRetry={() => void endpoints.refetch()}
      onRefresh={() => void endpoints.refetch()}
      busy={endpoints.isFetching}
      headingLevel={3}
      empty={{
        isEmpty: (v) => v.items.length === 0,
        content: (
          <p className="text-sm text-foreground-light">{t('infra.cluster.endpoints.none')}</p>
        ),
      }}
      ready={(v) => <EndpointTable endpoints={v.items} />}
    />
  )
}

function EndpointTable({ endpoints }: { readonly endpoints: readonly EndpointView[] }): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('infra.cluster.endpoints.what')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('infra.cluster.endpoints.label')}</TableHead>
          <TableHead scope="col">{t('infra.cluster.endpoints.kind')}</TableHead>
          <TableHead scope="col">{t('infra.cluster.endpoints.address')}</TableHead>
          <TableHead scope="col">{t('infra.cluster.endpoints.tls')}</TableHead>
          <TableHead scope="col">{t('infra.cluster.endpoints.state')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {endpoints.map((endpoint) => (
          <TableRow key={endpoint.id} data-endpoint={endpoint.id}>
            <TableCell>
              <UntrustedName name={endpoint.label} label={t('infra.cluster.endpoints.label')} />
            </TableCell>
            <TableCell>
              <UntrustedName
                name={
                  endpoint.poolerMode === null
                    ? endpoint.kind
                    : `${endpoint.kind} (${endpoint.poolerMode})`
                }
                label={t('infra.cluster.endpoints.kind')}
              />
            </TableCell>
            <TableCell>
              <UntrustedName
                name={`${endpoint.host}:${endpoint.port}`}
                mono
                label={t('infra.cluster.endpoints.address')}
              />
            </TableCell>
            <TableCell>
              <UntrustedName
                name={endpoint.tlsServerName}
                mono
                label={t('infra.cluster.endpoints.tls')}
              />
            </TableCell>
            <TableCell>{t(`infra.cluster.endpoint.${endpoint.state}`)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function RolesSection({
  cluster,
  tier,
}: {
  readonly cluster: Cluster
  readonly tier: 'prod' | 'nonprod'
}): ReactNode {
  const { client } = useApi()
  const nodes = useQuery(nodesQuery(client))
  if (cluster.managementMode === 'external') {
    return <p className="text-sm text-foreground-light">{t('infra.roles.external')}</p>
  }
  if (nodes.isError && classifyFailure(nodes.error).kind === 'not_permitted') {
    return (
      <NotPermittedState what={t('infra.nodes.what')} permission="nodes.read" headingLevel={3} />
    )
  }
  return (
    <ReadableView
      readable={toReadable(nodes)}
      what={t('infra.nodes.what')}
      onRetry={() => void nodes.refetch()}
      onRefresh={() => void nodes.refetch()}
      busy={nodes.isFetching}
      headingLevel={3}
      empty={{
        isEmpty: (v) => servingNode(v.items, cluster.serverId) === undefined,
        content: <p className="text-sm text-foreground-light">{t('infra.roles.noNode')}</p>,
      }}
      ready={(v) => {
        const node = servingNode(v.items, cluster.serverId)
        if (node === undefined) {
          return <p className="text-sm text-foreground-light">{t('infra.roles.noNode')}</p>
        }
        return (
          <div className="flex flex-col gap-6">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              {t('infra.roles.node')}{' '}
              <ObjectLink href={nodePath(node.id)} text={node.id} label={t('infra.column.id')} />
              <NodeStateBadge state={node.state} />
            </p>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('infra.roles.observed.title')}</h3>
              <ObservedRoles cluster={cluster} node={node} />
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('infra.roles.desired.title')}</h3>
              <DesiredRolesForm cluster={cluster} node={node} tier={tier} />
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('infra.verifier.title')}</h3>
              <RoleVerifierForm cluster={cluster} />
            </div>
          </div>
        )
      }}
    />
  )
}

function CredentialsHandOff({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const Link = useLinkComponent()
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {ACCESS_ROLES.map((role: AccessRole) => {
        const href = credentialsPath(cluster.id, role)
        return (
          <li key={role} className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-xs">{`exponetdb_${role}`}</code>
            {href === undefined ? null : (
              <Link href={href} className="text-primary underline focus-ring">
                {t('infra.cluster.credentials.link', { role })}
              </Link>
            )}
          </li>
        )
      })}
    </ul>
  )
}

import type { NodeJob, NodeStatus } from '@exponetdb/sdk/operations'
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
  KeyValueList,
  NotPermittedState,
  ObservedTime,
  ReadableView,
  TierChip,
  TypedConfirmDialog,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { NotFoundPage } from '../../shell/not-found.tsx'
import { usePlanRequest } from './actions.ts'
import { isNodeId, nodeJobsQuery, nodeQuery, serverQuery } from './keys.ts'
import {
  clusterPath,
  isKeyId,
  keyList,
  NODE_CERT_WARNING_HOURS,
  nodeIsTerminal,
  serverPath,
} from './model.ts'
import { ClockSkew, Expiry, InfraPage, InfraSection, NodeStateBadge, ObjectLink } from './parts.tsx'

/**
 * `/infrastructure/nodes/<nod_…>` (information-architecture.md §2.3): the
 * agent's state, version, capabilities, heartbeat with its age, clock skew,
 * host metrics and the clusters it reports, each with source and time
 * (`GET /nodes/{id}`); its recent jobs (`GET /nodes/{id}/jobs`: never an
 * envelope, the arguments or a signature); and its operations as plans:
 * job-key update, revocation and decommissioning (the last two behind a
 * typed confirmation of the node id). A node whose server is production,
 * or whose tier is not known, carries the production frame.
 */
export function NodeDetailPage({ nodeId }: { readonly nodeId: string }): ReactNode {
  if (!isNodeId(nodeId)) return <NotFoundPage />
  return <NodeDetail nodeId={nodeId} />
}

function NodeDetail({ nodeId }: { readonly nodeId: string }): ReactNode {
  const { client } = useApi()
  const node = useQuery(nodeQuery(client, nodeId))
  const jobs = useQuery(nodeJobsQuery(client, nodeId))
  const server = useQuery({
    ...serverQuery(client, node.data?.serverId ?? ''),
    enabled: node.data !== undefined,
  })
  if (node.isError && classifyFailure(node.error).kind === 'not_found') return <NotFoundPage />
  // Fails closed: a server whose tier is not known (yet) counts as production.
  const tier = server.data?.derivedTier === 'nonprod' ? 'nonprod' : 'prod'
  const production = node.data !== undefined && tier === 'prod'
  return (
    <InfraPage
      // The id is one long word: it wraps anywhere instead of pushing a phone's page sideways (TC-038).
      title={
        <span data-wrap="anywhere" className="min-w-0 [overflow-wrap:anywhere]">
          {t('infra.node.title', { id: nodeId })}
        </span>
      }
      description={t('infra.node.description')}
      production={production}
    >
      <InfraSection id="node-status" title={t('infra.node.status.title')}>
        <ReadableView
          readable={toReadable(node, { staleAfterMs: 60_000 })}
          what={t('infra.node.what')}
          onRetry={() => void node.refetch()}
          onRefresh={() => void node.refetch()}
          busy={node.isFetching}
          headingLevel={3}
          ready={(value) => (
            <NodeStatusView
              node={value}
              tier={server.data === undefined ? undefined : server.data.derivedTier}
            />
          )}
        />
      </InfraSection>
      <InfraSection
        id="node-jobs"
        title={t('infra.node.jobs.title')}
        description={t('infra.node.jobs.description')}
      >
        {jobs.isError && classifyFailure(jobs.error).kind === 'not_permitted' ? (
          <NotPermittedState
            what={t('infra.node.jobs.what')}
            permission="nodes.read"
            headingLevel={3}
          />
        ) : (
          <ReadableView
            readable={toReadable(jobs, {
              missing: (v) =>
                v.nextCursor === null ? undefined : [t('infra.node.jobs.more', { count: 50 })],
            })}
            what={t('infra.node.jobs.what')}
            onRetry={() => void jobs.refetch()}
            onRefresh={() => void jobs.refetch()}
            busy={jobs.isFetching}
            headingLevel={3}
            empty={{
              isEmpty: (v) => v.items.length === 0,
              content: <p className="text-sm text-foreground-light">{t('infra.node.jobs.none')}</p>,
            }}
            ready={(v) => <JobTable jobs={v.items} />}
          />
        )}
      </InfraSection>
      {node.data === undefined ? null : (
        <InfraSection
          id="node-operations"
          title={t('infra.node.operations.title')}
          description={t('infra.node.operations.description')}
        >
          <NodeOperations node={node.data} tier={tier} />
        </InfraSection>
      )}
    </InfraPage>
  )
}

function NodeStatusView({
  node,
  tier,
}: {
  readonly node: NodeStatus
  readonly tier: 'prod' | 'nonprod' | null | undefined
}): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <KeyValueList
        items={[
          {
            id: 'state',
            label: t('infra.nodes.column.state'),
            value: (
              <NodeStateBadge
                state={node.state}
                source={node.source}
                observedAt={node.observedAt}
              />
            ),
          },
          {
            id: 'server',
            label: t('infra.nodes.column.server'),
            value: (
              <span className="inline-flex flex-wrap items-center gap-2">
                <ObjectLink
                  href={serverPath(node.serverId)}
                  text={node.serverId}
                  label={t('infra.nodes.column.server')}
                />
                {tier === undefined ? null : tier === null ? (
                  <span className="text-xs text-foreground-light">
                    {t('infra.tier.noneDerived')}
                  </span>
                ) : (
                  <TierChip tier={tier} />
                )}
              </span>
            ),
          },
          {
            id: 'version',
            label: t('infra.nodes.column.version'),
            value:
              node.agentVersion === null ? (
                t('infra.node.version.none')
              ) : (
                <span>
                  <UntrustedName
                    name={node.agentVersion}
                    mono
                    label={t('infra.nodes.column.version')}
                  />
                  {node.protocolMajor === null
                    ? null
                    : ` ${t('infra.node.protocol', { major: node.protocolMajor })}`}
                </span>
              ),
          },
          {
            id: 'heartbeat',
            label: t('infra.nodes.column.heartbeat'),
            value:
              node.lastHeartbeatAt === null ? (
                t('infra.node.heartbeat.none')
              ) : (
                <ObservedTime observedAt={node.lastHeartbeatAt} withDate seconds />
              ),
          },
          {
            id: 'skew',
            label: t('infra.nodes.column.skew'),
            value: <ClockSkew skewMs={node.clockSkewMs} />,
          },
          {
            id: 'certificate',
            label: t('infra.node.certificate'),
            value:
              node.nodeCertificateExpiresAt === null ? (
                t('infra.value.notKnown')
              ) : (
                <Expiry
                  notAfter={node.nodeCertificateExpiresAt}
                  warnMs={NODE_CERT_WARNING_HOURS * 3_600_000}
                />
              ),
          },
          {
            id: 'host',
            label: t('infra.node.host'),
            value:
              node.host === null
                ? t('infra.node.host.none')
                : t('infra.node.host.value', {
                    load: node.host.loadAverage1m.toFixed(2),
                    memory: (node.host.memoryUsedBytes / 1024 ** 3).toFixed(1),
                    disk: node.host.diskUsedPercent.toFixed(0),
                  }),
          },
          {
            id: 'source',
            label: t('infra.node.reported'),
            value: (
              <span>
                {t(`infra.source.${node.source === 'agent_reported' ? 'agent' : 'store'}`)}{' '}
                <ObservedTime observedAt={node.observedAt} withDate />
              </span>
            ),
          },
        ]}
      />
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-medium">{t('infra.node.capabilities.title')}</h4>
        {node.capabilities.length === 0 ? (
          <p className="text-sm text-foreground-light">{t('infra.node.capabilities.none')}</p>
        ) : (
          <ul aria-label={t('infra.node.capabilities.title')} className="flex flex-wrap gap-1.5">
            {node.capabilities.map((capability) => (
              <li
                key={`${capability.name}@${capability.major}`}
                className="rounded-sm border border-default px-1.5 py-0.5 text-xs"
              >
                <UntrustedName
                  name={`${capability.name}@${capability.major}`}
                  mono
                  label={t('infra.node.capabilities.title')}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-medium">{t('infra.node.clusters.title')}</h4>
        {node.clusters.length === 0 ? (
          <p className="text-sm text-foreground-light">{t('infra.node.clusters.none')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {node.clusters.map((cluster) => (
              <li key={cluster.localName} className="flex flex-wrap items-center gap-2">
                <UntrustedName
                  name={cluster.localName}
                  mono
                  label={t('infra.node.clusters.local')}
                />
                {cluster.clusterId === null ? (
                  <span className="text-xs text-foreground-light">
                    {t('infra.node.clusters.unmapped')}
                  </span>
                ) : (
                  <ObjectLink
                    href={clusterPath(cluster.clusterId)}
                    text={cluster.clusterId}
                    label={t('infra.column.id')}
                  />
                )}
                <span className="text-xs">
                  {cluster.running
                    ? t('infra.node.clusters.running')
                    : t('infra.node.clusters.stopped')}
                  {cluster.pendingRestart ? ` · ${t('infra.node.clusters.pendingRestart')}` : ''}
                </span>
                {cluster.serverCertificateExpiresAt === null ? null : (
                  <Expiry notAfter={cluster.serverCertificateExpiresAt} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function JobTime({
  value,
  empty,
}: {
  readonly value: string | null
  readonly empty: string
}): ReactNode {
  return value === null ? (
    <span className="text-foreground-light">{empty}</span>
  ) : (
    <ObservedTime observedAt={value} withDate />
  )
}

/** States of a job that ended without a result the store could know. */
const ENDED_WITHOUT_RESULT = new Set(['expired', 'canceled', 'outcome_unknown'])

function JobTable({ jobs }: { readonly jobs: readonly NodeJob[] }): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('infra.node.jobs.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('infra.node.jobs.column.capability')}</TableHead>
          <TableHead scope="col">{t('infra.node.jobs.column.state')}</TableHead>
          <TableHead scope="col">{t('infra.node.jobs.column.outcome')}</TableHead>
          <TableHead scope="col">{t('infra.node.jobs.column.signature')}</TableHead>
          <TableHead scope="col">{t('infra.node.jobs.column.created')}</TableHead>
          <TableHead scope="col">{t('infra.node.jobs.column.started')}</TableHead>
          <TableHead scope="col">{t('infra.node.jobs.column.finished')}</TableHead>
          <TableHead scope="col">{t('infra.node.jobs.column.operation')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id} data-job={job.id}>
            <TableCell>
              <UntrustedName
                name={`${job.capability}@${job.capabilityMajor}`}
                mono
                label={t('infra.node.jobs.column.capability')}
              />
            </TableCell>
            <TableCell>
              <UntrustedName name={job.state} label={t('infra.node.jobs.column.state')} />
            </TableCell>
            <TableCell>
              {job.outcome !== null ? (
                <UntrustedName name={job.outcome} label={t('infra.node.jobs.column.outcome')} />
              ) : ENDED_WITHOUT_RESULT.has(job.state) ? (
                t('infra.value.notKnown')
              ) : (
                t('infra.node.jobs.noResult')
              )}
            </TableCell>
            <TableCell>
              {job.resultVerified === true
                ? t('infra.node.jobs.verified')
                : job.resultVerified === false
                  ? t('infra.node.jobs.notVerified')
                  : t('infra.node.jobs.notJudged')}
            </TableCell>
            <TableCell>
              <ObservedTime observedAt={job.createdAt} withDate />
            </TableCell>
            <TableCell>
              <JobTime
                value={job.startedAt}
                empty={
                  ENDED_WITHOUT_RESULT.has(job.state)
                    ? t('infra.value.notKnown')
                    : t('infra.node.jobs.notStarted')
                }
              />
            </TableCell>
            <TableCell>
              <JobTime value={job.finishedAt} empty={t('infra.node.jobs.open')} />
            </TableCell>
            <TableCell>
              <code className="font-mono text-xs">{job.operationId}</code>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function NodeOperations({
  node,
  tier,
}: {
  readonly node: NodeStatus
  readonly tier: 'prod' | 'nonprod'
}): ReactNode {
  const request = usePlanRequest()
  if (nodeIsTerminal(node.state)) {
    return <p className="text-sm text-foreground-light">{t('infra.node.operations.terminal')}</p>
  }
  return (
    <div className="flex flex-col gap-6">
      <ConfigUpdateForm nodeId={node.id} />
      <div className="flex flex-wrap gap-2">
        <TypedConfirmDialog
          trigger={
            <Button id="node-revoke" variant="danger" size="small">
              {t('infra.node.revoke.button')}
            </Button>
          }
          title={t('infra.node.revoke.title')}
          description={t('infra.node.revoke.description')}
          actionLabel={t('infra.node.revoke.action')}
          destructive
          tier={tier}
          expectedText={node.id}
          onConfirm={() =>
            request((client) =>
              client.operation('planNodeRevocation', { params: { nodeId: node.id }, body: {} }),
            )
          }
        />
        <TypedConfirmDialog
          trigger={
            <Button id="node-decommission" variant="danger" size="small">
              {t('infra.node.decommission.button')}
            </Button>
          }
          title={t('infra.node.decommission.title')}
          description={t('infra.node.decommission.description')}
          actionLabel={t('infra.node.decommission.action')}
          destructive
          tier={tier}
          expectedText={node.id}
          onConfirm={() =>
            request((client) =>
              client.operation('planNodeDecommissioning', {
                params: { nodeId: node.id },
                body: {},
              }),
            )
          }
        />
      </div>
    </div>
  )
}

function ConfigUpdateForm({ nodeId }: { readonly nodeId: string }): ReactNode {
  const request = usePlanRequest()
  const addId = useId()
  const retireId = useId()
  const [alert, setAlert] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    const addJobKeys = keyList(String(data.get('addJobKeys') ?? ''))
    const retireJobKeys = keyList(String(data.get('retireJobKeys') ?? ''))
    const all = [...addJobKeys, ...retireJobKeys]
    if (all.length === 0) {
      setAlert(t('infra.node.config.empty'))
      return
    }
    if (addJobKeys.length > 2 || retireJobKeys.length > 2 || !all.every(isKeyId)) {
      setAlert(t('infra.node.config.invalid'))
      return
    }
    if (new Set(all).size !== all.length) {
      setAlert(t('infra.node.config.twice'))
      return
    }
    setAlert('')
    setBusy(true)
    request((client) =>
      client.operation('planNodeConfigUpdate', {
        params: { nodeId },
        body: { addJobKeys, retireJobKeys },
      }),
    )
      .catch((error: unknown) => setAlert(describeError(error)))
      .finally(() => setBusy(false))
  }
  return (
    <form
      id="node-config-form"
      className="flex max-w-md flex-col gap-3"
      onSubmit={submit}
      noValidate
    >
      <h4 className="text-sm font-medium">{t('infra.node.config.title')}</h4>
      <p className="text-sm text-foreground-light">{t('infra.node.config.description')}</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={addId}>{t('infra.node.config.add')}</Label>
        <Input id={addId} name="addJobKeys" autoComplete="off" spellCheck={false} disabled={busy} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={retireId}>{t('infra.node.config.retire')}</Label>
        <Input
          id={retireId}
          name="retireJobKeys"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
      </div>
      <p className="alert text-sm text-destructive" role="alert">
        {alert}
      </p>
      <div>
        <Button type="submit" variant="default" size="small" loading={busy}>
          {t('infra.node.config.submit')}
        </Button>
      </div>
    </form>
  )
}

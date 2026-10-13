import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { ObservedTime, type Readable, UntrustedName } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import type { Target, TargetHealth } from '../target/queries.ts'
import { LiveReadView } from './live-read.tsx'
import { type Endpoints, useEndpoints } from './queries.ts'

type EndpointView = Endpoints['items'][number]
type Probe = TargetHealth['probes'][number]

/**
 * The endpoints of the target's cluster (direct, pooler) with the latest
 * probe result of each, from the health sample. A probe is a recorded
 * observation with its own time, never a fresh check made by this page.
 * Endpoint labels and addresses are registry text and render as untrusted
 * names. A cluster with no endpoint, a target without a placement and a
 * health read that failed each say so; none is an empty table.
 */
export function EndpointsSection(props: {
  readonly target: Target
  readonly health: Readable<TargetHealth>
  readonly onRetryHealth: () => void
}): ReactNode {
  const clusterId = props.target.placement?.clusterId
  const endpoints = useEndpoints(clusterId)
  return (
    <section aria-labelledby="endpoints-title" className="flex flex-col gap-3">
      <h2 id="endpoints-title" className="text-base font-medium text-foreground">
        {t('connections.endpoints.title')}
      </h2>
      {clusterId === undefined ? (
        <p className="text-sm text-foreground-light">{t('connections.endpoints.noPlacement')}</p>
      ) : (
        <LiveReadView
          readable={endpoints.readable}
          what={nounPhrase('connections.endpoints.what')}
          onRetry={endpoints.refetch}
          busy={endpoints.fetching}
          isEmpty={(value) => value.items.length === 0}
          empty={
            <p className="text-sm text-foreground-light">{t('connections.endpoints.empty')}</p>
          }
          ready={(value) => (
            <ProbeJoin
              endpoints={value.items}
              health={props.health}
              onRetryHealth={props.onRetryHealth}
            />
          )}
        />
      )}
    </section>
  )
}

const KIND_KEYS: Readonly<Record<EndpointView['kind'], MessageKey>> = {
  private: 'connections.endpoints.kind.private',
  public: 'connections.endpoints.kind.public',
  local_socket: 'connections.endpoints.kind.local_socket',
  pooler: 'connections.endpoints.kind.pooler',
}

const OUTCOME_KEYS: Readonly<Record<Probe['outcome'], MessageKey>> = {
  ok: 'connections.endpoints.probe.ok',
  failed: 'connections.endpoints.probe.failed',
  timeout: 'connections.endpoints.probe.timeout',
}

const TLS_KEYS: Readonly<Record<Probe['tls'], MessageKey>> = {
  verified: 'connections.endpoints.tls.verified',
  failed: 'connections.endpoints.tls.failed',
  not_reached: 'connections.endpoints.tls.not_reached',
}

function ProbeJoin(props: {
  readonly endpoints: readonly EndpointView[]
  readonly health: Readable<TargetHealth>
  readonly onRetryHealth: () => void
}): ReactNode {
  return (
    <LiveReadView
      readable={props.health}
      what={nounPhrase('connections.endpoints.healthWhat')}
      onRetry={props.onRetryHealth}
      busy={false}
      ready={(health) => {
        const known = new Set(props.endpoints.map((endpoint) => endpoint.id))
        const unmatched = health.probes.filter(
          (probe) => probe.endpoint.id === null || !known.has(probe.endpoint.id),
        )
        return (
          <Table>
            <TableCaption className="sr-only">{t('connections.endpoints.caption')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('connections.endpoints.column.endpoint')}</TableHead>
                <TableHead scope="col">{t('connections.endpoints.column.kind')}</TableHead>
                <TableHead scope="col">{t('connections.endpoints.column.address')}</TableHead>
                <TableHead scope="col">{t('connections.endpoints.column.state')}</TableHead>
                <TableHead scope="col">{t('connections.endpoints.column.probes')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.endpoints.map((endpoint) => (
                <TableRow key={endpoint.id} data-endpoint={endpoint.id}>
                  <TableCell>
                    <UntrustedName
                      name={endpoint.label}
                      label={t('connections.endpoints.column.endpoint')}
                    />
                  </TableCell>
                  <TableCell>
                    {endpoint.kind === 'pooler' && endpoint.poolerMode !== null
                      ? t('connections.endpoints.pooler', { mode: endpoint.poolerMode })
                      : t(KIND_KEYS[endpoint.kind])}
                  </TableCell>
                  <TableCell>
                    <UntrustedName
                      name={`${endpoint.host}:${endpoint.port}`}
                      mono
                      label={t('connections.endpoints.column.address')}
                    />
                  </TableCell>
                  <TableCell>
                    {t(
                      endpoint.state === 'active'
                        ? 'connections.endpoints.active'
                        : 'connections.endpoints.retired',
                    )}
                  </TableCell>
                  <TableCell>
                    <Probes
                      probes={health.probes.filter((probe) => probe.endpoint.id === endpoint.id)}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {unmatched.map((probe) => (
                <TableRow key={`${probe.endpoint.id ?? probe.endpoint.label}:${probe.probe}`}>
                  <TableCell>
                    <UntrustedName
                      name={probe.endpoint.label}
                      label={t('connections.endpoints.column.endpoint')}
                    />
                  </TableCell>
                  <TableCell>{t(KIND_KEYS[probe.endpoint.kind])}</TableCell>
                  <TableCell>{t('connections.endpoints.notRegistered')}</TableCell>
                  <TableCell>{t('connections.endpoints.notRegistered')}</TableCell>
                  <TableCell>
                    <Probes probes={[probe]} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      }}
    />
  )
}

function Probes({ probes }: { readonly probes: readonly Probe[] }): ReactNode {
  if (probes.length === 0) {
    return <span className="text-xs">{t('connections.endpoints.noProbe')}</span>
  }
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {probes.map((probe) => (
        <li key={probe.probe} data-probe={probe.probe} data-outcome={probe.outcome}>
          {t('connections.endpoints.probe', {
            probe: probe.probe,
            outcome: nounPhrase(OUTCOME_KEYS[probe.outcome]),
            duration:
              probe.durationMs === null
                ? ''
                : t('connections.endpoints.probe.duration', { ms: probe.durationMs }),
            tls: nounPhrase(TLS_KEYS[probe.tls]),
            verified: probe.endpoint.verified ? '' : t('connections.endpoints.probe.unverified'),
          })}
          {probe.errorClass === null ? null : (
            <>
              {' '}
              <UntrustedName
                name={t('connections.endpoints.probe.error', { errorClass: probe.errorClass })}
                label={t('connections.endpoints.column.probes')}
              />
            </>
          )}{' '}
          <ObservedTime observedAt={probe.observedAt} seconds />
        </li>
      ))}
    </ul>
  )
}

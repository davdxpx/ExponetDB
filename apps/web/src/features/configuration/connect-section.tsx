import { Lock } from '@exponetdb/icons'
import { KeyValueList, ObservedTime, StateMessage, UntrustedName } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useId } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { holds } from '../access/fields.tsx'
import { clusterDatabasesQuery, clusterEndpointsQuery } from '../infrastructure/keys.ts'
import { targetHealthQuery } from '../target/keys.ts'
import { nounPhrase } from '../target/phrases.ts'
import type { Target, TargetHealth } from '../target/queries.ts'
import { ReadSection, type SectionQuery } from '../target-ops/read-section.tsx'
import { Section } from '../target-ops/section.tsx'
import { CopyButton } from '../targets/copy.tsx'
import {
  type ConnectEndpoint,
  type ConnectModel,
  connectionLines,
  connectModel,
  type EndpointCheck,
  endpointCheck,
} from './connect-model.ts'

/**
 * The connect panel of a target: where an application connects (host, port,
 * database, TLS server name, `sslmode=verify-full`), a connection URI and a
 * `psql` command with placeholders, and what the recorded probes say about
 * each endpoint. It holds no secret and builds none: the role and the
 * password are placeholders, and ExponetDB never holds an application
 * password. Endpoint addresses are visible to `registry.manage` only (the
 * server decides again), so a person without it gets a named state and the
 * page makes no request for them.
 */
export function ConnectSection({ target }: { readonly target: Target }): ReactNode {
  const me = useMe()
  const clusterId = target.placement?.clusterId
  return (
    <Section
      id="connect"
      title={t('configuration.connect.title')}
      description={t('configuration.connect.description')}
    >
      {!holds(me, 'registry.manage') ? (
        <StateMessage
          data-state="not-permitted"
          icon={<Lock aria-hidden className="size-5 text-foreground-light" />}
          title={t('configuration.connect.notPermitted.title')}
          headingLevel={3}
        >
          <p>{t('configuration.connect.notPermitted.body')}</p>
        </StateMessage>
      ) : clusterId === undefined ? (
        <p className="m-0 text-sm text-foreground-light">
          {t('configuration.connect.noPlacement')}
        </p>
      ) : (
        <ConnectPanel target={target} clusterId={clusterId} />
      )}
    </Section>
  )
}

interface Joined {
  readonly model: ConnectModel
}

function ConnectPanel({
  target,
  clusterId,
}: {
  readonly target: Target
  readonly clusterId: string
}): ReactNode {
  const { client } = useApi()
  const endpoints = useQuery(clusterEndpointsQuery(client, clusterId))
  const databases = useQuery(clusterDatabasesQuery(client, clusterId))
  const health = useQuery(targetHealthQuery(client, target.path, true))

  // The panel needs the endpoints and, for the database name, the databases of
  // the cluster. It waits for both to settle; if only the databases failed it
  // still shows the endpoints and says what is missing (a partial read).
  const databasesSettled = databases.data !== undefined || databases.isError
  const model: ConnectModel | undefined =
    endpoints.data === undefined || !databasesSettled
      ? undefined
      : connectModel({
          endpoints: endpoints.data,
          databases: databases.data,
          ...(databases.data === undefined
            ? { databasesFailure: classifyFailure(databases.error).message }
            : {}),
          targetId: target.id,
        })
  const combined: SectionQuery<Joined> = {
    data: model === undefined ? undefined : { model },
    error: endpoints.error ?? databases.error,
    isError: endpoints.isError || (databases.isError && databases.data !== undefined),
    dataUpdatedAt:
      databases.data === undefined
        ? endpoints.dataUpdatedAt
        : Math.min(endpoints.dataUpdatedAt, databases.dataUpdatedAt),
    isFetching: endpoints.isFetching || databases.isFetching,
    refetch: () => {
      void endpoints.refetch()
      void databases.refetch()
    },
  }
  return (
    <ReadSection
      query={combined}
      what={nounPhrase('configuration.connect.what')}
      permission="registry.manage"
      missing={(value) => (value.model.missing.length === 0 ? undefined : value.model.missing)}
      empty={{
        isEmpty: (value) => value.model.endpoints.length === 0,
        content: (
          <p className="m-0 text-sm text-foreground-light">{t('configuration.connect.empty')}</p>
        ),
      }}
      ready={(value) => <Endpoints model={value.model} health={health} />}
    />
  )
}

function Endpoints({
  model,
  health,
}: {
  readonly model: ConnectModel
  readonly health: {
    readonly data: TargetHealth | undefined
    readonly error: unknown
    readonly isError: boolean
    readonly isPending: boolean
  }
}): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {model.endpoints.map((endpoint) => (
          <EndpointCard
            key={endpoint.id}
            endpoint={endpoint}
            database={model.database}
            health={health}
          />
        ))}
      </ul>
      {model.localSockets > 0 ? (
        <p className="m-0 text-xs text-foreground-light">
          {t('configuration.connect.localSockets', { count: model.localSockets })}
        </p>
      ) : null}
      <p className="m-0 text-xs text-foreground-light">{t('configuration.connect.note')}</p>
    </div>
  )
}

function kindText(endpoint: ConnectEndpoint): string {
  if (endpoint.kind === 'private') return t('configuration.connect.kind.private')
  if (endpoint.kind === 'public') return t('configuration.connect.kind.public')
  return endpoint.poolerMode === null
    ? t('configuration.connect.kind.poolerUnknown')
    : t('configuration.connect.kind.pooler', { mode: endpoint.poolerMode })
}

function EndpointCard({
  endpoint,
  database,
  health,
}: {
  readonly endpoint: ConnectEndpoint
  readonly database: string | undefined
  readonly health: Parameters<typeof Endpoints>[0]['health']
}): ReactNode {
  const id = useId()
  const lines = database === undefined ? undefined : connectionLines(endpoint, database)
  return (
    <li
      data-endpoint={endpoint.id}
      data-kind={endpoint.kind}
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-md border border-default p-card"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={`${id}-title`} className="m-0 text-sm font-medium text-foreground">
          <UntrustedName name={endpoint.label} label={t('infra.cluster.endpoints.label')} />
        </h3>
        <span className="text-xs text-foreground-light">{kindText(endpoint)}</span>
      </div>
      <KeyValueList
        items={[
          {
            id: 'host',
            label: t('configuration.connect.host'),
            value: (
              <UntrustedName name={endpoint.host} mono label={t('configuration.connect.host')} />
            ),
          },
          { id: 'port', label: t('configuration.connect.port'), value: String(endpoint.port) },
          {
            id: 'database',
            label: t('configuration.connect.database'),
            value:
              database === undefined ? (
                t('configuration.connect.database.notKnown')
              ) : (
                <UntrustedName name={database} mono label={t('configuration.connect.database')} />
              ),
          },
          {
            id: 'tls',
            label: t('configuration.connect.tls'),
            value: (
              <UntrustedName
                name={endpoint.tlsServerName}
                mono
                label={t('configuration.connect.tls')}
              />
            ),
          },
          {
            id: 'sslmode',
            label: t('configuration.connect.sslmode'),
            value: <code className="font-mono text-xs">verify-full</code>,
          },
          {
            id: 'check',
            label: t('configuration.connect.check'),
            value: <Check endpointId={endpoint.id} health={health} />,
          },
        ]}
      />
      {lines === undefined ? null : lines.kind === 'unsafe' ? (
        <p className="m-0 text-sm text-foreground-light">
          {t(
            lines.what === 'database'
              ? 'configuration.connect.unsafe.database'
              : 'configuration.connect.unsafe.host',
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {lines.address ? (
            <p className="m-0 text-xs text-foreground-light">
              {t('configuration.connect.ip', { name: endpoint.tlsServerName })}
            </p>
          ) : null}
          <Snippet
            label={t('configuration.connect.uri')}
            copyLabel={t('configuration.connect.uri.copy')}
            text={lines.uri}
          />
          <Snippet
            label={t('configuration.connect.psql')}
            copyLabel={t('configuration.connect.psql.copy')}
            text={lines.psql}
          />
        </div>
      )}
    </li>
  )
}

function Check({
  endpointId,
  health,
}: {
  readonly endpointId: string
  readonly health: Parameters<typeof Endpoints>[0]['health']
}): ReactNode {
  if (health.data === undefined) {
    if (!health.isError) return <span>{t('configuration.connect.check.loading')}</span>
    const failure = classifyFailure(health.error)
    return (
      <span>
        {failure.kind === 'not_permitted'
          ? t('configuration.connect.check.denied')
          : t('configuration.connect.check.failed', {
              reason: `${failure.message} (${failure.code})`,
            })}
      </span>
    )
  }
  const check: EndpointCheck | undefined = endpointCheck(endpointId, health.data.probes)
  if (check === undefined) return <span>{t('configuration.connect.check.none')}</span>
  return (
    <span data-check={check.tls} className="flex flex-col gap-0.5">
      <span>{t(`configuration.connect.check.tls.${check.tls}`)}</span>
      <span>{t('configuration.connect.check.probes', { ok: check.ok, total: check.total })}</span>
      <span>
        {t(
          check.identityVerified
            ? 'configuration.connect.check.identity.verified'
            : 'configuration.connect.check.identity.unverified',
        )}
      </span>
      <span className="text-xs text-foreground-light">
        <ObservedTime observedAt={check.observedAt} />
      </span>
    </span>
  )
}

/** A line to copy, as text with a copy button (the text carries placeholders, never a secret). */
function Snippet({
  label,
  copyLabel,
  text,
}: {
  readonly label: string
  readonly copyLabel: string
  readonly text: string
}): ReactNode {
  return (
    <figure className="m-0 overflow-hidden rounded-md border bg-surface-75">
      <figcaption className="flex items-center justify-between gap-2 border-b px-3 py-1 text-xs text-foreground-light">
        <span>{label}</span>
        <CopyButton what={label} label={copyLabel} text={text} />
      </figcaption>
      <pre className="m-0 whitespace-pre-wrap break-all p-3 font-mono text-xs text-foreground">
        <code>{text}</code>
      </pre>
    </figure>
  )
}

import { Badge } from '@exponetdb/ui'
import {
  type KeyValueItem,
  KeyValueList,
  NotPermittedState,
  ObservedTime,
  ReadableView,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import {
  healthQuery,
  type Installation,
  type InstallationHealth,
  installationQuery,
} from './keys.ts'
import { SettingsFrame } from './settings-frame.tsx'

/**
 * `/settings/installation`: what this installation is (id, version, contract
 * versions, enabled features; `GET /installation`) and how the Control Plane
 * is (`GET /installation/health`, read every 30 seconds): each component with
 * its state, source and time, and every component this release cannot observe
 * listed as not observed with its reason, never counted as operational.
 */
export function InstallationPage(): ReactNode {
  const { client } = useApi()
  const installation = useQuery(installationQuery(client))
  const health = useQuery(healthQuery(client))
  return (
    <SettingsFrame
      title={t('settings.installation.title')}
      description={t('settings.installation.description')}
    >
      <section aria-labelledby="installation-about" className="flex flex-col gap-3">
        <h2 id="installation-about" className="text-base font-medium text-foreground">
          {t('settings.installation.about')}
        </h2>
        <ReadableView
          readable={toReadable(installation, { staleAfterMs: 24 * 60 * 60_000 })}
          what={t('settings.installation.what')}
          headingLevel={3}
          onRetry={() => void installation.refetch()}
          onRefresh={() => void installation.refetch()}
          busy={installation.isFetching}
          ready={(value) => <About installation={value} />}
        />
      </section>
      <section aria-labelledby="installation-health" className="flex flex-col gap-3">
        <h2 id="installation-health" className="text-base font-medium text-foreground">
          {t('settings.installation.health')}
        </h2>
        {health.isError &&
        health.data === undefined &&
        classifyFailure(health.error).kind === 'not_permitted' ? (
          <NotPermittedState
            what={t('settings.installation.health.what')}
            permission="nodes.read"
            headingLevel={3}
          />
        ) : (
          <ReadableView
            readable={toReadable(health)}
            what={t('settings.installation.health.what')}
            headingLevel={3}
            onRetry={() => void health.refetch()}
            onRefresh={() => void health.refetch()}
            busy={health.isFetching}
            ready={(value) => <Health health={value} />}
          />
        )}
      </section>
    </SettingsFrame>
  )
}

function About({ installation }: { readonly installation: Installation }): ReactNode {
  const items: KeyValueItem[] = [
    {
      id: 'installation-id',
      label: t('settings.installation.id'),
      value:
        installation.installationId === undefined ? (
          <span className="text-foreground-lighter">{t('settings.installation.id.none')}</span>
        ) : (
          <code className="font-mono text-xs">{installation.installationId}</code>
        ),
    },
    {
      id: 'version',
      label: t('settings.installation.version'),
      value: (
        <UntrustedName
          name={installation.version}
          mono
          label={t('settings.installation.version')}
        />
      ),
    },
    {
      id: 'contracts',
      label: t('settings.installation.contracts'),
      value: (
        <ul className="flex flex-col gap-0.5 font-mono text-xs">
          {Object.entries(installation.contracts).map(([name, version]) => (
            <li key={name}>{`${name}: ${version}`}</li>
          ))}
        </ul>
      ),
    },
    {
      id: 'features',
      label: t('settings.installation.features'),
      value:
        installation.features.length === 0 ? (
          t('settings.installation.features.none')
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {installation.features.map((feature) => (
              <li key={feature}>
                <Badge className="font-mono">{feature}</Badge>
              </li>
            ))}
          </ul>
        ),
    },
  ]
  return <KeyValueList items={items} />
}

type HealthState = InstallationHealth['state']

function stateLabel(state: HealthState): string {
  switch (state) {
    case 'operational':
      return t('settings.installation.state.operational')
    case 'degraded':
      return t('settings.installation.state.degraded')
    case 'down':
      return t('settings.installation.state.down')
  }
}

function StateBadgeOf({ state }: { readonly state: HealthState }): ReactNode {
  return (
    <Badge
      variant={
        state === 'operational' ? 'success' : state === 'degraded' ? 'warning' : 'destructive'
      }
      data-state={state}
    >
      {stateLabel(state)}
    </Badge>
  )
}

function Health({ health }: { readonly health: InstallationHealth }): ReactNode {
  const unobserved = health.unobserved ?? []
  return (
    <div className="flex flex-col gap-4">
      <p
        className="flex flex-wrap items-center gap-2 text-sm text-foreground"
        id="installation-state"
      >
        {t('settings.installation.overall')} <StateBadgeOf state={health.state} />
        {unobserved.length > 0 ? (
          <span className="text-foreground-light">
            {t('settings.installation.overall.partial', { count: unobserved.length })}
          </span>
        ) : null}
      </p>
      <ul id="installation-components" className="flex flex-col gap-2">
        {health.components.map((component) => (
          <li
            key={component.component}
            className="flex flex-col gap-1 rounded-md border border-default p-3"
            data-component={component.component}
            data-state={component.state}
          >
            <span className="flex flex-wrap items-center gap-2 text-sm">
              <code className="font-mono text-foreground">{component.component}</code>
              <StateBadgeOf state={component.state} />
              <span className="text-xs text-foreground-lighter">
                {t('settings.installation.source', { source: component.source })}{' '}
                <ObservedTime observedAt={component.observedAt} withDate />
              </span>
            </span>
            {component.reasons === undefined || component.reasons.length === 0 ? null : (
              <span className="font-mono text-xs text-foreground-light">
                {t('settings.installation.reasons', { reasons: component.reasons.join(', ') })}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">
          {t('settings.installation.unobserved')}
        </h3>
        {unobserved.length === 0 ? (
          <p className="text-sm text-foreground-lighter">
            {t('settings.installation.unobserved.none')}
          </p>
        ) : (
          <ul id="installation-unobserved" className="flex flex-col gap-1">
            {unobserved.map((entry) => (
              <li key={entry.component} className="text-sm" data-unobserved={entry.component}>
                {t('settings.installation.unobserved.item', {
                  component: entry.component,
                  reason: entry.reason,
                })}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

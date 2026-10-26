import type { InstallationHealth } from '@exponetdb/sdk/operations'
import { Card, cn } from '@exponetdb/ui'
import { ObservedTime, ReadableView, UntrustedName, UntrustedText } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { inlineName } from '../consent/inline-name.ts'
import { HealthChip } from './health.tsx'
import { controlPlaneQuery } from './keys.ts'

const CP_CHIP = { operational: 'healthy', degraded: 'degraded', down: 'unhealthy' } as const

/**
 * How ExponetDB itself is doing (C-29: the Control Plane's health is not a target's): the overall
 * state, then each component with its state, reasons, source and age as one compact row, and the
 * components it could not observe, which are never shown as healthy.
 */
export function ControlPlane({ className }: { readonly className?: string }): ReactNode {
  const { client } = useApi()
  const health = useQuery(controlPlaneQuery(client))
  return (
    <section aria-labelledby="fleet-cp" className={cn('flex min-w-0 flex-col gap-3', className)}>
      <h2 id="fleet-cp" className="m-0 text-base font-medium">
        {t('fleet.cp.title')}
      </h2>
      <ReadableView
        readable={toReadable(health, {
          missing: (value) =>
            (value.unobserved ?? []).length === 0
              ? undefined
              : (value.unobserved ?? []).map((u) =>
                  // Plain text: hidden and direction characters are shown by their code points.
                  t('fleet.cp.unobserved.row', {
                    component: inlineName(u.component, 64) ?? '',
                    reason: inlineName(u.reason, 120) ?? '',
                  }),
                ),
        })}
        what={t('fleet.cp.what')}
        onRetry={() => void health.refetch()}
        onRefresh={() => void health.refetch()}
        busy={health.isFetching}
        headingLevel={3}
        ready={(value) => <ControlPlaneBody health={value} />}
      />
    </section>
  )
}

function ControlPlaneBody({ health }: { readonly health: InstallationHealth }): ReactNode {
  const unobserved = health.unobserved ?? []
  return (
    <Card className="flex flex-col">
      <p className="m-0 flex items-center gap-2 border-b px-4 py-3 text-sm">
        <HealthChip state={CP_CHIP[health.state]} />
        <span>{t('fleet.cp.state', { state: t(`fleet.cp.state.${health.state}`) })}</span>
      </p>
      {health.components.length === 0 ? (
        <p className="m-0 px-4 py-3 text-sm text-foreground-light">{t('fleet.cp.none')}</p>
      ) : (
        <ul aria-label={t('fleet.cp.caption')} className="m-0 flex list-none flex-col p-0">
          {health.components.map((component) => (
            <li
              key={component.component}
              data-component={component.component}
              className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b px-4 py-2.5 text-sm last:border-b-0"
            >
              <UntrustedName
                name={component.component}
                mono
                label={t('fleet.cp.column.component')}
              />
              <HealthChip state={CP_CHIP[component.state]} />
              <span className="ml-auto text-xs text-foreground-lighter">
                <UntrustedName
                  name={component.source}
                  mono
                  maxCodePoints={24}
                  label={t('fleet.cp.column.source')}
                />
                {', '}
                <ObservedTime observedAt={component.observedAt} />
              </span>
              {(component.reasons ?? []).length === 0 ? null : (
                <span className="flex w-full flex-col gap-0.5">
                  {(component.reasons ?? []).map((reason) => (
                    <UntrustedText key={reason} text={reason} className="text-xs" />
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {unobserved.length === 0 ? null : (
        <div data-unobserved className="flex flex-col gap-1 border-t border-strong px-4 py-3">
          <h3 className="m-0 text-sm font-medium">{t('fleet.cp.unobserved.title')}</h3>
          <p className="m-0 text-xs text-foreground-light">{t('fleet.cp.unobserved.body')}</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {unobserved.map((u) => (
              <li key={u.component} className="flex flex-wrap items-center gap-2">
                <HealthChip state="unknown" />
                <UntrustedName name={u.component} mono label={t('fleet.cp.column.component')} />
                <UntrustedText text={u.reason} className="text-xs" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

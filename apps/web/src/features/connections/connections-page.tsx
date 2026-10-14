import { NotAvailableYetState, readableValue } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { useTargetHealth } from '../target/queries.ts'
import { useTargetScope } from '../target/scope.tsx'
import { EndpointsSection } from './endpoints-view.tsx'
import { LiveReadView } from './live-read.tsx'
import { LockGraphView } from './locks-view.tsx'
import { DiagnosticsFrame } from './page-frame.tsx'
import { useLocks, useSessions } from './queries.ts'
import { SessionsView } from './sessions-view.tsx'

/**
 * `/t/<product>/<project>/<environment>/connections` (order section 8,
 * Studio's database connections as a specification): the sessions of the
 * target grouped by role and application with their states, who blocks whom,
 * and the endpoints with their probe results. The frame renders the
 * unreachable and "cannot tell" states before any of this (the page needs
 * the target reachable); each read below renders its own truthful state.
 * Cancel and terminate are not controls: they come as planned operations in
 * Wave 9, and the page names that state.
 */
export function ConnectionsPage(): ReactNode {
  return (
    <DiagnosticsFrame section="connections" description={t('connections.page.description')}>
      <ConnectionsBody />
    </DiagnosticsFrame>
  )
}

function ConnectionsBody(): ReactNode {
  const scope = useTargetScope()
  const sessions = useSessions(scope.target.path)
  const locks = useLocks(scope.target.path)
  const health = useTargetHealth(scope.target.path)
  const target = readableValue(scope.read)
  const graph = readableValue(locks.readable)
  return (
    <>
      <section aria-labelledby="sessions-title" className="flex flex-col gap-3">
        <h2 id="sessions-title" className="text-base font-medium text-foreground">
          {t('connections.sessions.title')}
        </h2>
        <LiveReadView
          readable={sessions.readable}
          what={nounPhrase('connections.sessions.what')}
          onRetry={sessions.refetch}
          busy={sessions.fetching}
          isEmpty={(value) => value.sessions.length === 0}
          empty={<p className="text-sm text-foreground-light">{t('connections.sessions.empty')}</p>}
          ready={(value) => (
            <SessionsView list={value} locks={graph} targetPath={scope.target.path} />
          )}
        />
        <NotAvailableYetState
          what={t('connections.operate.what')}
          reason={t('connections.operate.reason')}
          headingLevel={3}
        />
      </section>
      <section aria-labelledby="blocking-title" className="flex flex-col gap-3">
        <h2 id="blocking-title" className="text-base font-medium text-foreground">
          {t('connections.blocking.title')}
        </h2>
        <LiveReadView
          readable={locks.readable}
          what={nounPhrase('locks.what')}
          onRetry={locks.refetch}
          busy={locks.fetching}
          isEmpty={(value) => value.waits.length === 0}
          empty={<p className="text-sm text-foreground-light">{t('locks.empty')}</p>}
          ready={(value) => <LockGraphView graph={value} headingLevel={3} />}
        />
      </section>
      {target === undefined ? null : (
        <EndpointsSection target={target} health={health.readable} onRetryHealth={health.refetch} />
      )}
    </>
  )
}

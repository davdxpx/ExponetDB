import { type ReactNode, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { useTargetScope } from '../target/scope.tsx'
import { LiveControls } from './live-controls.tsx'
import { LiveReadView } from './live-read.tsx'
import { LockGraphView } from './locks-view.tsx'
import { observedAtOf } from './model.ts'
import { DiagnosticsFrame } from './page-frame.tsx'
import { useLocks, useSessions } from './queries.ts'

/**
 * `/t/<product>/<project>/<environment>/locks`: the lock graph of the target
 * as a blocking tree and a table, with its source and age. Each blocker in
 * the tree is joined to the sessions read (state, how long, role,
 * application, redacted statement), with the sessions read's time said as
 * "as of". An empty graph is shown only after a successful read; a read that
 * failed, or a target that could not be read live, is said as that and never
 * as "no locks". The sessions are a second read: if it fails the tree is
 * still shown, from the lock graph alone, and says so.
 */
export function LocksPage(): ReactNode {
  return (
    <DiagnosticsFrame section="locks" description={t('locks.page.description')}>
      <LocksBody />
    </DiagnosticsFrame>
  )
}

function LocksBody(): ReactNode {
  const scope = useTargetScope()
  const [live, setLive] = useState(true)
  const locks = useLocks(scope.target.path, { live })
  const sessions = useSessions(scope.target.path, { live })
  const refresh = (): void => {
    locks.refetch()
    sessions.refetch()
  }
  return (
    <>
      <LiveControls
        live={live}
        onLiveChange={(next) => {
          setLive(next)
          // A resumed page reads at once instead of waiting out an interval.
          if (next) refresh()
        }}
        onRefresh={refresh}
        busy={locks.fetching || sessions.fetching}
        observedAt={[observedAtOf(locks.readable), observedAtOf(sessions.readable)]}
      />
      <LiveReadView
        readable={locks.readable}
        what={nounPhrase('locks.what')}
        onRetry={locks.refetch}
        busy={locks.fetching}
        isEmpty={(value) => value.waits.length === 0}
        empty={<p className="text-sm text-foreground-light">{t('locks.empty')}</p>}
        ready={(value) => (
          <LockGraphView graph={value} headingLevel={3} sessions={sessions.readable} />
        )}
      />
    </>
  )
}

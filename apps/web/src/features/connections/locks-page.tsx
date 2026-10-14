import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { useTargetScope } from '../target/scope.tsx'
import { LiveReadView } from './live-read.tsx'
import { LockGraphView } from './locks-view.tsx'
import { DiagnosticsFrame } from './page-frame.tsx'
import { useLocks } from './queries.ts'

/**
 * `/t/<product>/<project>/<environment>/locks`: the lock graph of the target
 * as a blocking tree and a table, with its source and age. An empty graph is
 * shown only after a successful read; a read that failed, or a target that
 * could not be read live, is said as that and never as "no locks".
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
  const locks = useLocks(scope.target.path)
  return (
    <LiveReadView
      readable={locks.readable}
      what={nounPhrase('locks.what')}
      onRetry={locks.refetch}
      busy={locks.fetching}
      isEmpty={(value) => value.waits.length === 0}
      empty={<p className="text-sm text-foreground-light">{t('locks.empty')}</p>}
      ready={(value) => <LockGraphView graph={value} headingLevel={3} />}
    />
  )
}

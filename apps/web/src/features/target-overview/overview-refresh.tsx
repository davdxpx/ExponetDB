import { RefreshCw } from '@exponetdb/icons'
import { Button } from '@exponetdb/ui'
import { ObservedTime } from '@exponetdb/ui-patterns'
import { type Query, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { useTargetScope } from '../target/scope.tsx'

/**
 * Whether a cached read is one the overview shows for this target: the
 * blocks' own reads (`overview`), the latest health sample (`targets`, by
 * path) and the node read of the host row (`infrastructure`, `nodes`). The
 * target itself (the layout's read, which the facts block and the page's gate
 * use) is asked again with them but is not one of the blocks: when it fails
 * the page shows its own stale or failed state in place of the blocks, so a
 * round is counted over the blocks' reads. Only reads that are mounted
 * (`type: 'active'`) are asked again, so a read of another page or target is
 * never started by this button.
 */
export function isOverviewRead(
  path: string,
  options: { readonly withTarget: boolean },
): (query: Query) => boolean {
  return (query) => {
    const [area, kind, subject] = query.queryKey
    if (area === 'overview') return true
    if (area === 'targets') {
      return (kind === 'health' || (options.withTarget && kind === 'detail')) && subject === path
    }
    return area === 'infrastructure' && kind === 'nodes'
  }
}

interface Round {
  /** When the reads came back (ISO 8601). */
  readonly at: string
  readonly failed: number
  readonly total: number
}

/**
 * "Refresh" for the overview: reads every block's data again now, and says
 * when that finished and how it went. The reads still fail on their own: a
 * block whose read failed shows its own failed state, and this line only
 * counts them ("2 of 7 reads failed"). It never says "updated" for a round in
 * which nothing could be read. Reads the sampler wrote are read again, not
 * probed: the page never starts a probe (health.md §7).
 */
export function RefreshBar(): ReactNode {
  const queryClient = useQueryClient()
  const scope = useTargetScope()
  const [running, setRunning] = useState(false)
  const [round, setRound] = useState<Round | undefined>(undefined)

  const refresh = async (): Promise<void> => {
    if (running) return
    setRunning(true)
    const path = scope.target.path
    try {
      await queryClient.refetchQueries({
        predicate: isOverviewRead(path, { withTarget: true }),
        type: 'active',
      })
    } finally {
      const queries = queryClient
        .getQueryCache()
        .findAll({ predicate: isOverviewRead(path, { withTarget: false }), type: 'active' })
      setRound({
        at: new Date().toISOString(),
        total: queries.length,
        failed: queries.filter((query) => query.state.status === 'error').length,
      })
      setRunning(false)
    }
  }

  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-3 border-0 p-0">
      <legend className="sr-only">{t('overview.refresh.group')}</legend>
      <Button
        type="button"
        size="tiny"
        variant="outline"
        // Busy and not pressable while the reads run, and still reachable by the keyboard.
        loading={running}
        focusableWhenDisabled
        icon={<RefreshCw aria-hidden="true" className="size-3.5" />}
        onClick={() => void refresh()}
      >
        {t('overview.refresh.button')}
      </Button>
      <span className="text-xs text-foreground-light" role="status" data-slot="refresh-result">
        {running ? (
          t('overview.refresh.running')
        ) : round === undefined ? null : round.total > 0 && round.failed === round.total ? (
          t('overview.refresh.allFailed', { total: round.total })
        ) : (
          <>
            {t('overview.refresh.updated')} <ObservedTime observedAt={round.at} seconds />
            {round.failed === 0
              ? null
              : ` ${t('overview.refresh.someFailed', { failed: round.failed, total: round.total })}`}
          </>
        )}
      </span>
    </fieldset>
  )
}

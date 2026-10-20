import { RefreshCw } from '@exponetdb/icons'
import { Button, cn } from '@exponetdb/ui'
import { ObservedTime } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { oldestObservation } from './model.ts'
import { DIAGNOSTICS_POLL_MS } from './queries.ts'

/**
 * Live / pause and refresh for the reads of a diagnostics page. Pausing stops
 * the polling and nothing else: a refresh still reads, and the paused state
 * lives in the page for this visit only (it is not stored). The text says
 * which mode the page is in and how old the oldest read it shows is; a
 * paused page that grows old turns its reads stale on time (see
 * `queries.ts`), so pausing never leaves old data looking current.
 */
export function LiveControls(props: {
  readonly live: boolean
  readonly onLiveChange: (live: boolean) => void
  readonly onRefresh: () => void
  /** A read is running (a poll or a refresh): the icon turns, the button stays usable. */
  readonly busy: boolean
  /** The observation times of the reads the page shows. */
  readonly observedAt: readonly (string | undefined)[]
}): ReactNode {
  const observed = oldestObservation(props.observedAt)
  return (
    <fieldset
      data-live={props.live ? 'true' : 'false'}
      className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-0 p-0"
    >
      <legend className="sr-only">{t('connections.live.group')}</legend>
      <Button
        type="button"
        size="tiny"
        variant="outline"
        onClick={() => props.onLiveChange(!props.live)}
      >
        {props.live ? t('connections.live.pause') : t('connections.live.resume')}
      </Button>
      <Button
        type="button"
        size="tiny"
        variant="outline"
        icon={
          <RefreshCw
            aria-hidden="true"
            className={cn('size-3.5', props.busy && 'animate-spin motion-reduce:animate-none')}
          />
        }
        onClick={props.onRefresh}
      >
        {t('connections.live.refresh')}
      </Button>
      <span className="text-xs text-foreground-light" aria-live="polite">
        {props.live
          ? t('connections.live.on', { seconds: DIAGNOSTICS_POLL_MS / 1_000 })
          : t('connections.live.paused')}
      </span>
      <span className="text-xs text-foreground-light" data-slot="observed">
        {observed === undefined ? (
          t('connections.live.nothing')
        ) : (
          <>
            {t('connections.observation')} <ObservedTime observedAt={observed} seconds />
          </>
        )}
      </span>
    </fieldset>
  )
}

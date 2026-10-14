import { CircleHelp } from '@exponetdb/icons'
import { Button } from '@exponetdb/ui'
import {
  ObservedTime,
  type Readable,
  ReadableView,
  type ReadMeta,
  SourceLabel,
  StateMessage,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { isLiveUnreadable } from './model.ts'

/**
 * A live read of the target (sessions, lock graph, endpoints). It renders
 * through `ReadableView`, so loading, failed, stale and partial are the shared
 * states and an empty list appears only after a successful read. One more
 * state is named here: when the server says the target could not be read now
 * (unavailable, credential, TLS, identity mismatch, sample stale) the page
 * says it cannot tell, with the server's reason, and that this is neither "no
 * sessions" nor "healthy" (health.md section 1).
 */
export function LiveReadView<T>(props: {
  readonly readable: Readable<T>
  /** What is read, as a noun phrase that works after "no": "sessions". */
  readonly what: string
  readonly ready: (value: T, meta: ReadMeta) => ReactNode
  readonly isEmpty?: (value: T) => boolean
  readonly empty?: ReactNode
  readonly onRetry: () => void
  readonly busy: boolean
}): ReactNode {
  const { readable } = props
  if (readable.state === 'failed' && isLiveUnreadable(readable.error.code)) {
    return (
      <StateMessage
        data-state="cannot-tell"
        icon={<CircleHelp aria-hidden className="size-5 text-foreground-light" />}
        title={t('connections.cannotTell.title')}
        headingLevel={3}
        actions={
          <Button type="button" size="tiny" variant="outline" onClick={props.onRetry}>
            {t('connections.cannotTell.retry')}
          </Button>
        }
      >
        <p>
          {t('connections.cannotTell.body', {
            reason: t('error.withCode', {
              message: readable.error.message,
              code: readable.error.code,
            }),
            what: props.what,
          })}
        </p>
      </StateMessage>
    )
  }
  const isEmpty = props.isEmpty
  return (
    <ReadableView
      readable={readable}
      what={props.what}
      onRetry={props.onRetry}
      onRefresh={props.onRetry}
      busy={props.busy}
      headingLevel={3}
      {...(isEmpty === undefined
        ? {}
        : {
            empty: {
              isEmpty,
              ...(props.empty === undefined ? {} : { content: props.empty }),
            },
          })}
      ready={props.ready}
    />
  )
}

/** "Observed 4 s ago, Live": the age and the source of a read the server stamped. */
export function Observation(props: {
  readonly source: string
  readonly observedAt: string
}): ReactNode {
  const known = (['live', 'sampled', 'cached', 'agent_reported', 'inferred'] as const).find(
    (s) => s === props.source,
  )
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-foreground-light">
      <span>
        {t('connections.observation')} <ObservedTime observedAt={props.observedAt} seconds />
      </span>
      {known === undefined ? null : <SourceLabel source={known} />}
    </p>
  )
}

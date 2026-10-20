import { AlertTriangle } from '@exponetdb/icons'
import { Button, copyToClipboard, Textarea } from '@exponetdb/ui'
import { StateMessage } from '@exponetdb/ui-patterns'
import { useQueryClient } from '@tanstack/react-query'
import {
  type ErrorComponentProps,
  useMatch,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { type Installation, settingsKeys } from '../features/settings/keys.ts'
import { t } from '../lib/i18n/i18n.ts'

/**
 * What the page does when a route fails to render (an exception while React
 * draws it). The router's own fallback shows the raw message of the
 * exception, and an exception message can hold data (a row, a name from a
 * catalog, text a server sent), so this page never reads the error at all:
 * it says what happened, offers "Try again" (the router loads the page's
 * data again and draws it anew) and "Reload", and offers a diagnostic that
 * holds only facts that are not data: the id of the route (its template, such
 * as `/_app/t/$product/$project/$environment/sql`, never the address), the
 * version of the app when an earlier read already holds it, and the time.
 * Nothing is requested while the page is in this state and nothing is sent
 * anywhere: no stack, no telemetry.
 */

/** The browser actions of the page, in one place so a test can replace the reload. */
export const crashActions = {
  reload: (): void => window.location.reload(),
}

/** The text the person copies: three facts, one per line. */
export function diagnosticText(facts: {
  readonly route: string
  /** The version of the app when it is known, else `undefined` (said as "not read"). */
  readonly version: string | undefined
  readonly time: Date
}): string {
  return [
    t('crash.details.route', { route: facts.route }),
    facts.version === undefined
      ? t('crash.details.versionUnknown')
      : t('crash.details.version', { version: facts.version }),
    t('crash.details.time', { time: facts.time.toISOString() }),
  ].join('\n')
}

/**
 * The app version from the installation read, when the query cache already
 * holds a successful one. Reading the cache never starts a request.
 */
function cachedVersion(read: Installation | undefined): string | undefined {
  const version: unknown = read?.version
  return typeof version === 'string' && version.length > 0 ? version : undefined
}

type CopyStatus = 'idle' | 'copied' | 'failed'

const PAGE_ID = 'crash-page'

/**
 * The default error component of every route and the root route's. The
 * `error` the router hands over is deliberately not used.
 */
export function RouteErrorPage({ reset }: ErrorComponentProps): ReactNode {
  const router = useRouter()
  const queryClient = useQueryClient()
  const failing = useMatch({ strict: false, select: (match) => match.routeId })
  // Inside the shell the page is in the `main` landmark already; when the shell itself (or a
  // page outside it) failed, the page is the landmark.
  const shellStands = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === '/_app'),
  })
  const landmark = !shellStands || failing === '/_app'
  const [time] = useState(() => new Date())
  const [status, setStatus] = useState<CopyStatus>('idle')
  const detailsId = useId()

  // Keyboard and screen reader users land on the explanation, not on a page that is gone.
  useEffect(() => {
    document.getElementById(PAGE_ID)?.focus()
  }, [])

  const details = diagnosticText({
    route: failing ?? t('crash.details.routeUnknown'),
    version: cachedVersion(queryClient.getQueryData<Installation>(settingsKeys.installation)),
    time,
  })
  const retry = (): void => {
    // The router reads the page's data again and draws it anew; the boundary leaves its error state
    // with it, and `reset` leaves it at once for a page whose failure was in the drawing alone.
    void router.invalidate()
    reset()
  }
  const copy = (): void => {
    void copyToClipboard(details).then((done) => setStatus(done ? 'copied' : 'failed'))
  }
  const Root = landmark ? 'main' : 'div'
  return (
    <Root className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <StateMessage
        id={PAGE_ID}
        tabIndex={-1}
        data-state="render-failed"
        icon={<AlertTriangle aria-hidden className="size-5 text-foreground-light" />}
        title={t('crash.title')}
        headingLevel={2}
        className="focus-ring"
        actions={
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" variant="default" size="small" onClick={retry}>
              {t('crash.retry')}
            </Button>
            <Button type="button" variant="outline" size="small" onClick={crashActions.reload}>
              {t('crash.reload')}
            </Button>
          </div>
        }
      >
        <p>{t('crash.body')}</p>
      </StateMessage>
      <section
        aria-labelledby={detailsId}
        className="flex flex-col gap-2 rounded-lg border border-default p-4"
      >
        <h2 id={detailsId} className="text-sm font-medium text-foreground">
          {t('crash.details.title')}
        </h2>
        <p className="text-sm text-foreground-light">{t('crash.details.body')}</p>
        <Textarea
          readOnly
          rows={3}
          value={details}
          aria-label={t('crash.details.label')}
          className="font-mono text-xs"
        />
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="tiny" onClick={copy}>
            {t('crash.details.copy')}
          </Button>
          <span role="status" className="text-xs text-foreground-light">
            {status === 'copied' ? t('crash.details.copied') : null}
            {status === 'failed' ? t('crash.details.copyFailed') : null}
          </span>
        </div>
      </section>
    </Root>
  )
}

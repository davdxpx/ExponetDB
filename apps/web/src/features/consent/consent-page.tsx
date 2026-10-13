import type { ConsentView } from '@exponetdb/contracts'
import { Admonition } from '@exponetdb/ui-patterns'
import { type ReactNode, useEffect, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { requestHandle } from '../../lib/navigation/links.ts'
import { useMe } from '../../lib/session/guard.tsx'
import type { ConsentDecision } from './consent-model.ts'
import {
  ConsentScreen,
  connectedTitle,
  DecisionScreen,
  InvalidRequestScreen,
  LoadingScreen,
  ReadFailedScreen,
} from './consent-screens.tsx'
import { leaveTo } from './leave.ts'
import { useRawHash } from './raw-location.ts'

/**
 * `/oauth/consent#request=exar_…` (oauth.md §4, order Appendix A): the
 * person decides a pending authorization request. The handle comes from
 * the fragment only (exact grammar, never from the query or the router's
 * decoded copy) and goes nowhere but the two ceremony calls: the view is
 * read with `POST /auth/oauth/consent/view` and the decision sent with
 * `POST /auth/oauth/consent`. The `__Host-exdb_oauth` cookie binds the
 * request to this browser; the page never touches it. The handle and the
 * view stay in this component's memory (never in the query cache or in
 * storage); another handle in the fragment mounts a fresh request, so
 * nothing decided here can act on another link's request.
 */
export function ConsentPage(): ReactNode {
  const handle = requestHandle(useRawHash())
  if (handle === undefined) return <InvalidRequestScreen />
  return <ConsentLoader key={handle} handle={handle} />
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: ConsentView }
  | { readonly status: 'failed'; readonly error: unknown }

function ConsentLoader({ handle }: { readonly handle: string }): ReactNode {
  const [attempt, setAttempt] = useState(0)
  return <ConsentRequest key={attempt} handle={handle} onRetry={() => setAttempt((n) => n + 1)} />
}

interface Outcome {
  readonly decision: ConsentDecision
  /** The client redirect could not be opened (not an http(s) URL). */
  readonly refused: boolean
}

function ConsentRequest({
  handle,
  onRetry,
}: {
  readonly handle: string
  readonly onRetry: () => void
}): ReactNode {
  const { client, confirmIdentity } = useApi()
  const me = useMe()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    client
      .ceremony<ConsentView>('/auth/oauth/consent/view', { request: handle }, controller.signal)
      .then(
        (view) => setLoad({ status: 'ready', view }),
        (error: unknown) => {
          if (!controller.signal.aborted) setLoad({ status: 'failed', error })
        },
      )
    return () => controller.abort()
  }, [client, handle])

  if (load.status === 'loading') return <LoadingScreen />
  if (load.status === 'failed') return <ReadFailedScreen error={load.error} onRetry={onRetry} />
  const view = load.view

  if (outcome !== undefined) {
    const allowed = outcome.decision.decision === 'allow'
    return (
      <DecisionScreen
        view={view}
        me={me}
        decision={outcome.decision}
        title={allowed ? connectedTitle(view) : t('consent.denied.title')}
      >
        {outcome.refused ? (
          <Admonition type="destructive" description={t('consent.leave.refused')} />
        ) : (
          <p role="status" className="text-center text-sm text-foreground-light">
            {t(allowed ? 'consent.success.returning' : 'consent.denied.body')}
          </p>
        )}
      </DecisionScreen>
    )
  }

  const decide = async (decision: ConsentDecision): Promise<void> => {
    const result = await withReauth(client, confirmIdentity, () =>
      client.ceremony<{ readonly redirectTo: string }>('/auth/oauth/consent', {
        request: handle,
        ...decision,
      }),
    )
    // The request is decided now: show the result and go to the client.
    setOutcome({ decision, refused: !leaveTo(result.redirectTo) })
  }

  return <ConsentScreen view={view} me={me} onDecide={decide} />
}

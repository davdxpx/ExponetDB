import type { EnrollmentTokenReveal } from '@exponetdb/sdk/operations'
import { Button, copyToClipboard, toast } from '@exponetdb/ui'
import { Admonition, ObservedTime, ReadableView } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { usePlanRequest } from './actions.ts'
import { enrollmentPlansQuery } from './keys.ts'
import { ENROLL_COMMANDS, type EnrollmentToken, enrollmentTokensOf, serverPath } from './model.ts'
import { ObjectLink } from './parts.tsx'

/**
 * Enrolling a node agent (control-plane.md §4, node-runbook.md §3) in two
 * steps, so the token secret never sits in a plan, an operation or a log:
 *
 * 1. "Plan enrollment" asks for the plan `node.enroll` of a server
 *    (`POST /servers/{id}/nodes/enroll`) and opens its review page, where it
 *    is applied with a fresh proof; the operation creates the token record,
 *    without a secret.
 * 2. "Reveal token" (`POST /enrollment-tokens/{id}/reveal`, a fresh proof,
 *    only the person who applied the plan, within 30 minutes, once) answers
 *    with the token. The page shows it once: it lives only in this
 *    component's state, never in the query cache, the address, history or
 *    browser storage, never in a toast or a log. Hiding it, leaving the page
 *    or reloading it ends it for good, and the server never reveals it again.
 */
export function EnrollNodeButton({ serverId }: { readonly serverId: string }): ReactNode {
  const request = usePlanRequest()
  const [busy, setBusy] = useState(false)
  const [alert, setAlert] = useState('')
  const plan = (): void => {
    if (busy) return
    setBusy(true)
    setAlert('')
    request((client) => client.operation('planNodeEnrollment', { params: { serverId }, body: {} }))
      .catch((error: unknown) => setAlert(describeError(error)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-foreground-light">{t('infra.enroll.planHint')}</p>
      <Button
        type="button"
        id="enroll-plan"
        variant="primary"
        size="small"
        loading={busy}
        onClick={plan}
      >
        {t('infra.enroll.plan')}
      </Button>
      <p className="alert text-sm text-destructive" role="alert">
        {alert}
      </p>
    </div>
  )
}

interface Revealed {
  readonly tokenId: string
  readonly reveal: EnrollmentTokenReveal
}

/**
 * The tokens the person's applied enrollment plans created, each with
 * "Reveal token". `serverId` narrows the list to one server.
 */
export function EnrollmentTokens({ serverId }: { readonly serverId?: string }): ReactNode {
  const { client, confirmIdentity } = useApi()
  const plans = useQuery(enrollmentPlansQuery(client))
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  // Ids of tokens revealed in this page (an id is not a secret); the server refuses a second reveal anyway.
  const [shown, setShown] = useState<readonly string[]>([])
  const [alert, setAlert] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const inFlight = useRef(false)

  const reveal = (token: EnrollmentToken): void => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(token.tokenId)
    setAlert('')
    withReauth(client, confirmIdentity, () =>
      client.operation('revealEnrollmentToken', { params: { tokenId: token.tokenId }, body: {} }),
    )
      .then(
        (answer) => {
          setRevealed({ tokenId: token.tokenId, reveal: answer })
          setShown((earlier) => [...earlier, token.tokenId])
        },
        (error: unknown) => setAlert(describeError(error)),
      )
      .finally(() => {
        inFlight.current = false
        setBusy(null)
      })
  }

  return (
    <div className="flex flex-col gap-3">
      {revealed === null ? null : (
        <RevealedToken revealed={revealed.reveal} onHide={() => setRevealed(null)} />
      )}
      <ReadableView
        readable={toReadable(plans, {
          missing: (value) =>
            value.nextCursor === null ? undefined : [t('infra.enroll.tokens.more')],
        })}
        what={t('infra.enroll.tokens.what')}
        onRetry={() => void plans.refetch()}
        onRefresh={() => void plans.refetch()}
        busy={plans.isFetching}
        headingLevel={3}
        empty={{
          isEmpty: (value) =>
            enrollmentTokensOf(value.items).filter(
              (token) => serverId === undefined || token.serverId === serverId,
            ).length === 0,
          content: <p className="text-sm text-foreground-light">{t('infra.enroll.tokens.none')}</p>,
        }}
        ready={(value) => (
          <ul className="flex flex-col gap-2" aria-label={t('infra.enroll.tokens.what')}>
            {enrollmentTokensOf(value.items)
              .filter((token) => serverId === undefined || token.serverId === serverId)
              .map((token) => (
                <li
                  key={token.tokenId}
                  data-token={token.tokenId}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-default p-3 text-sm"
                >
                  <span className="flex flex-col gap-0.5">
                    <span>
                      {t('infra.enroll.tokens.server')}{' '}
                      <ObjectLink
                        href={serverPath(token.serverId)}
                        text={token.serverId}
                        label={t('infra.enroll.tokens.server')}
                      />
                    </span>
                    <span className="text-xs text-foreground-light">
                      {t('infra.enroll.tokens.planned')}{' '}
                      <ObservedTime observedAt={token.createdAt} withDate />
                    </span>
                  </span>
                  {shown.includes(token.tokenId) ? (
                    <span className="text-xs text-foreground-light">
                      {t('infra.enroll.tokens.revealed')}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="default"
                      size="small"
                      loading={busy === token.tokenId}
                      onClick={() => reveal(token)}
                    >
                      {t('infra.enroll.reveal')}
                    </Button>
                  )}
                </li>
              ))}
          </ul>
        )}
      />
      <p className="text-xs text-foreground-light">{t('infra.enroll.tokens.window')}</p>
      <p className="alert text-sm text-destructive" role="alert">
        {alert}
      </p>
    </div>
  )
}

function RevealedToken({
  revealed,
  onHide,
}: {
  readonly revealed: EnrollmentTokenReveal
  readonly onHide: () => void
}): ReactNode {
  const copy = async (): Promise<void> => {
    if (await copyToClipboard(revealed.token)) {
      toast.success(t('infra.enroll.token.copied'))
    } else {
      toast.error(t('infra.enroll.token.copyFailed'))
    }
  }
  return (
    <section
      aria-label={t('infra.enroll.token.region')}
      className="secret flex flex-col gap-3 rounded-md border border-warning-500 bg-warning-200 p-4"
    >
      <div aria-live="polite" className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{t('infra.enroll.token.title')}</p>
        <p className="text-sm text-foreground-light">{t('infra.enroll.token.once')}</p>
        <p className="text-sm text-foreground-light">
          {t('infra.enroll.token.expires')}{' '}
          <ObservedTime observedAt={revealed.expiresAt} withDate />
        </p>
      </div>
      <code
        id="enrollment-token"
        className="once select-all break-all rounded-sm bg-surface-100 px-2 py-1 font-mono text-sm text-foreground"
      >
        {revealed.token}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="default" size="small" onClick={() => void copy()}>
          {t('infra.enroll.token.copy')}
        </Button>
        <Button type="button" variant="text" size="small" onClick={onHide}>
          {t('infra.enroll.token.hide')}
        </Button>
      </div>
      <Admonition type="default" title={t('infra.enroll.commands.title')}>
        <p className="text-sm">{t('infra.enroll.commands.body')}</p>
        <pre className="mt-2 overflow-x-auto rounded-sm bg-surface-100 p-2 font-mono text-xs">
          {ENROLL_COMMANDS.join('\n')}
        </pre>
      </Admonition>
    </section>
  )
}

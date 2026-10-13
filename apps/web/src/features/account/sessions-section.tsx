import { Badge, Button } from '@exponetdb/ui'
import { type Readable, ReadableView, UntrustedName } from '@exponetdb/ui-patterns'
import { type ReactNode, useId } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { TimeText } from '../sign-in/time-text.tsx'
import type { WebSession } from './account-model.ts'
import { SectionHeading } from './section.tsx'
import type { AccountWriter } from './writer.ts'

/**
 * The person's signed-in browsers (`#session-list`): the device text (sent
 * by a browser, so untrusted), since when, until when, and "Sign out" for
 * every session but this one; "Sign out all other sessions"
 * (`#revoke-others`). A recovery session has ended every other session
 * already and may not change anything here, so it shows no actions.
 */
export function SessionsSection({
  sessions,
  writer,
  recovery,
  onRetry,
}: {
  readonly sessions: Readable<{ readonly items: readonly WebSession[] }>
  readonly writer: AccountWriter
  readonly recovery: boolean
  readonly onRetry: () => void
}): ReactNode {
  const { client } = useApi()
  const headingId = useId()
  const locked = writer.busy !== undefined

  const signOut = (session: WebSession): void =>
    writer.write(`session:${session.id}`, async (reauth) => {
      await reauth(() =>
        client.operation('revokeMySession', { params: { sessionId: session.id }, body: {} }),
      )
      return t('account.session.signedOut')
    })

  const signOutOthers = (): void =>
    writer.write('revoke-others', async (reauth) => {
      const result = await reauth(() => client.operation('revokeMyOtherSessions', { body: {} }))
      return t('account.sessions.revokedOthers', { count: result.revoked })
    })

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId}>{t('account.sessions')}</SectionHeading>
      <ReadableView
        readable={sessions}
        what={t('account.sessions.what')}
        headingLevel={3}
        onRetry={onRetry}
        ready={(value) => (
          <ul
            id="session-list"
            className="flex flex-col divide-y divide-border rounded-lg border border-default"
          >
            {value.items.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                    <UntrustedName name={session.device} />
                    {session.current ? <Badge>{t('account.session.current')}</Badge> : null}
                  </span>
                  <p className="flex flex-wrap gap-x-3 text-xs text-foreground-lighter">
                    <span>
                      {t('account.session.since')} <TimeText value={session.createdAt} />
                    </span>
                    <span>
                      {t('account.session.ends')} <TimeText value={session.expiresAt} />
                    </span>
                  </p>
                </div>
                {session.current || recovery ? null : (
                  <Button
                    type="button"
                    variant="default"
                    size="tiny"
                    loading={writer.busy === `session:${session.id}`}
                    disabled={locked && writer.busy !== `session:${session.id}`}
                    onClick={() => signOut(session)}
                  >
                    {t('account.session.signOut')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      />
      {recovery ? null : (
        <div>
          <Button
            id="revoke-others"
            type="button"
            variant="default"
            size="small"
            loading={writer.busy === 'revoke-others'}
            disabled={locked && writer.busy !== 'revoke-others'}
            onClick={signOutOthers}
          >
            {t('account.sessions.revokeOthers')}
          </Button>
        </div>
      )}
    </section>
  )
}

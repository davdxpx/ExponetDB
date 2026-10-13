import { Badge, Button } from '@exponetdb/ui'
import { type Readable, ReadableView, UntrustedName } from '@exponetdb/ui-patterns'
import { type ReactNode, useId } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { TimeText } from '../sign-in/time-text.tsx'
import { activeGrants, type Grant, grantSummary, grantTargets, lastUseOf } from './account-model.ts'
import { SectionHeading } from './section.tsx'
import type { AccountWriter } from './writer.ts'

/**
 * Connected applications (`#grant-list`, `#no-grants`): what each client may
 * do on the person's behalf, revocable at once. The client's name is the
 * client's own claim: untrusted text, marked "name not verified" unless the
 * client is first party; no logo is ever loaded. "Last used" is the last use
 * the server recorded (minute and kind); without a record the page says "No
 * use recorded", never "never used".
 */
export function GrantsSection({
  grants,
  writer,
  onRetry,
}: {
  readonly grants: Readable<{ readonly items: readonly Grant[] }>
  readonly writer: AccountWriter
  readonly onRetry: () => void
}): ReactNode {
  const { client } = useApi()
  const headingId = useId()
  const locked = writer.busy !== undefined

  const revoke = (grant: Grant): void =>
    writer.write(`grant:${grant.id}`, async (reauth) => {
      await reauth(() =>
        client.operation('revokeMyGrant', { params: { grantId: grant.id }, body: {} }),
      )
      return t('account.grant.revoked')
    })

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId}>{t('account.grants')}</SectionHeading>
      <ReadableView
        readable={grants}
        what={t('account.grants.what')}
        headingLevel={3}
        onRetry={onRetry}
        empty={{
          isEmpty: (value) => activeGrants(value.items).length === 0,
          content: (
            <p id="no-grants" className="text-sm text-foreground-light">
              {t('account.grants.none')}
            </p>
          ),
        }}
        ready={(value) => (
          <ul
            id="grant-list"
            className="flex flex-col divide-y divide-border rounded-lg border border-default"
          >
            {activeGrants(value.items).map((grant) => (
              <GrantRow
                key={grant.id}
                grant={grant}
                busy={writer.busy === `grant:${grant.id}`}
                disabled={locked}
                onRevoke={() => revoke(grant)}
              />
            ))}
          </ul>
        )}
      />
    </section>
  )
}

function GrantRow({
  grant,
  busy,
  disabled,
  onRevoke,
}: {
  readonly grant: Grant
  readonly busy: boolean
  readonly disabled: boolean
  readonly onRevoke: () => void
}): ReactNode {
  const nameId = useId()
  const lastUse = lastUseOf(grant)
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
          <UntrustedName
            id={nameId}
            name={grant.client.name}
            unverified={!grant.client.firstParty}
          />
          {grant.client.firstParty ? <Badge>{t('account.grant.firstParty')}</Badge> : null}
        </span>
        <p className="text-sm text-foreground-light">{grantSummary(grant)}</p>
        <p className="flex flex-wrap gap-x-3 text-xs text-foreground-lighter">
          <span>{grantTargets(grant)}</span>
          <span>
            {t('account.grant.until')} <TimeText value={grant.expiresAt} />
          </span>
          {lastUse === undefined ? (
            <span>{t('account.grant.noUse')}</span>
          ) : (
            <span>
              {t('account.grant.lastUsed')} <TimeText value={lastUse.at} />
            </span>
          )}
          {lastUse?.use === undefined ? null : (
            <span>{t('account.grant.use', { use: lastUse.use })}</span>
          )}
        </p>
      </div>
      <Button
        type="button"
        variant="default"
        size="tiny"
        aria-describedby={nameId}
        loading={busy}
        disabled={disabled && !busy}
        onClick={onRevoke}
      >
        {t('account.grant.revoke')}
      </Button>
    </li>
  )
}

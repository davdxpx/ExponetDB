import { UntrustedName } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { rolesText } from './account-model.ts'
import type { ProfileMe } from './profile-model.ts'
import { AccountCard, AccountSection, CardRow } from './section.tsx'

/**
 * Who the signed-in person is: the address, the name and the audit label
 * (text a person or an administrator typed, so shown through the
 * untrusted-name pattern) and the active roles with their scope kinds, one
 * row each in a card.
 */
export function IdentitySection({ me }: { readonly me: ProfileMe }): ReactNode {
  const { email, label } = me.identity
  // The name the person chose wins over the one from the invitation.
  const displayName = me.displayName ?? me.identity.displayName
  return (
    <AccountSection title={t('account.you')}>
      <AccountCard>
        <CardRow label={t('account.email')}>
          {email === null ? (
            <span id="me-email" className="text-sm text-foreground">
              {t('account.unset')}
            </span>
          ) : (
            <UntrustedName
              id="me-email"
              name={email}
              label={t('account.email')}
              className="text-sm text-foreground"
            />
          )}
        </CardRow>
        <CardRow label={t('account.name')}>
          {displayName === null || displayName === '' ? (
            <span className="text-sm text-foreground">{t('account.unset')}</span>
          ) : (
            <UntrustedName
              name={displayName}
              label={t('account.name')}
              className="text-sm text-foreground"
            />
          )}
        </CardRow>
        <CardRow label={t('account.label')}>
          <UntrustedName
            name={label}
            mono
            label={t('account.label')}
            className="text-sm text-foreground"
          />
        </CardRow>
        <CardRow label={t('account.roles')}>
          <span id="me-roles" className="text-sm text-foreground">
            {rolesText(me)}
          </span>
        </CardRow>
      </AccountCard>
    </AccountSection>
  )
}

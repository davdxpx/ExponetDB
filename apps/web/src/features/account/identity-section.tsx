import { KeyValueList, UntrustedName } from '@exponetdb/ui-patterns'
import { type ReactNode, useId } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { rolesText } from './account-model.ts'
import type { ProfileMe } from './profile-model.ts'
import { SectionHeading } from './section.tsx'

/**
 * Who the signed-in person is: the address, the name and the audit label
 * (text a person or an administrator typed, so shown through the
 * untrusted-name pattern) and the active roles with their scope kinds.
 */
export function IdentitySection({ me }: { readonly me: ProfileMe }): ReactNode {
  const headingId = useId()
  const { email, label } = me.identity
  // The name the person chose wins over the one from the invitation.
  const displayName = me.displayName ?? me.identity.displayName
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId}>{t('account.you')}</SectionHeading>
      <KeyValueList
        items={[
          {
            id: 'email',
            label: t('account.email'),
            value:
              email === null ? (
                <span id="me-email">{t('account.unset')}</span>
              ) : (
                <UntrustedName id="me-email" name={email} label={t('account.email')} />
              ),
          },
          {
            id: 'name',
            label: t('account.name'),
            value:
              displayName === null || displayName === '' ? (
                t('account.unset')
              ) : (
                <UntrustedName name={displayName} label={t('account.name')} />
              ),
          },
          {
            id: 'label',
            label: t('account.label'),
            value: <UntrustedName name={label} mono label={t('account.label')} />,
          },
          {
            id: 'roles',
            label: t('account.roles'),
            value: <span id="me-roles">{rolesText(me)}</span>,
          },
        ]}
      />
    </section>
  )
}

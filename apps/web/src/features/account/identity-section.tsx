import { KeyValueList, UntrustedName } from '@exponetdb/ui-patterns'
import { type ReactNode, useId } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { type Me, rolesText } from './account-model.ts'
import { SectionHeading } from './section.tsx'

/**
 * Who the signed-in person is: the address, the name and the audit label
 * (text a person or an administrator typed, so shown through the
 * untrusted-name pattern) and the active roles with their scope kinds.
 */
export function IdentitySection({ me }: { readonly me: Me }): ReactNode {
  const headingId = useId()
  const { email, displayName, label } = me.identity
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
              displayName === null ? (
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

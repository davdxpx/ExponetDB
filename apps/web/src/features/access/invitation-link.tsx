import { Button, copyToClipboard, toast } from '@exponetdb/ui'
import { TimestampInfo } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { deliveryText, type Invitation } from './people-model.ts'

/**
 * A new invitation link, shown once (identity.md, "Enrollment"; C-20). The
 * link carries a one-time token: it comes only from the answer that issued
 * it and lives only in the page's component state, never in the query cache,
 * the URL, history state or storage, never in a toast. Hiding it or leaving
 * the page ends it for good; issuing a new link makes the old one useless.
 * The link is shown as text to copy, never as a link to follow here.
 */
export interface RevealedInvitation {
  readonly identityId: string
  /** Who was invited, for naming them next to the link: their name, else their address. Untrusted text. */
  readonly who: string
  readonly link: string
  readonly expiresAt: string
  readonly delivery: Invitation['invitation']['delivery']
}

export function revealedOf(invitation: Invitation): RevealedInvitation {
  return {
    identityId: invitation.identity.id,
    who: invitation.identity.displayName ?? invitation.identity.email ?? invitation.identity.label,
    link: invitation.invitation.link,
    expiresAt: invitation.invitation.expiresAt,
    delivery: invitation.invitation.delivery,
  }
}

export function InvitationLink({
  revealed,
  onHide,
  onAssign,
}: {
  readonly revealed: RevealedInvitation
  readonly onHide: () => void
  /** Offers "Assign a role" for the invited person; the page opens the binding form. */
  readonly onAssign?: (invitation: RevealedInvitation) => void
}): ReactNode {
  const copy = async (): Promise<void> => {
    if (await copyToClipboard(revealed.link)) {
      toast.success(t('people.invite.link.copied'))
    } else {
      toast.error(t('people.invite.link.copyFailed'))
    }
  }
  return (
    <section
      aria-label={t('people.invite.link.region')}
      className="secret flex flex-col gap-3 rounded-md border border-warning-500 bg-warning-200 p-4"
    >
      <div aria-live="polite" className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{t('people.invite.link.title')}</p>
        <p className="text-sm text-foreground-light">{t('people.invite.link.body')}</p>
        <p className="text-sm text-foreground-light">{deliveryText(revealed.delivery)}</p>
      </div>
      <code
        id="invitation-link"
        className="once select-all break-all rounded-sm bg-surface-100 px-2 py-1 font-mono text-sm text-foreground"
      >
        {revealed.link}
      </code>
      <p className="text-xs text-foreground-light">
        {t('people.invite.link.expires')} <TimestampInfo timestamp={revealed.expiresAt} />
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="default" size="small" onClick={() => void copy()}>
          {t('people.invite.link.copy')}
        </Button>
        {onAssign === undefined ? null : (
          <Button type="button" variant="default" size="small" onClick={() => onAssign(revealed)}>
            {t('people.assign.open')}
          </Button>
        )}
        <Button type="button" variant="text" size="small" onClick={onHide}>
          {t('people.invite.link.hide')}
        </Button>
      </div>
    </section>
  )
}

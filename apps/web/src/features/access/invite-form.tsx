import { Button, Input } from '@exponetdb/ui'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { useAccessAction } from './actions.ts'
import { Field } from './fields.tsx'
import { type RevealedInvitation, revealedOf } from './invitation-link.tsx'
import { peopleKeys } from './people-keys.ts'
import type { StatusLine } from './status.tsx'

/**
 * Invites a person (`#invite-person`, identity.md "Enrollment"): an address
 * and an optional name. The new identity is `invited` and holds no role; the
 * answer carries a one-time link the page shows once (`InvitationLink`) and
 * never caches. Re-authentication when the server asks for it. The address
 * is checked for its shape only; the server decides.
 */
const EMAIL = /^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,190}\.[^\s@\p{Cc}]{1,63}$/u
const NAME_MAX = 128

export function InviteForm({
  line,
  onRevealed,
}: {
  readonly line: StatusLine
  readonly onRevealed: (revealed: RevealedInvitation) => void
}): ReactNode {
  const action = useAccessAction()
  const id = useId()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<{ email?: string; name?: string }>({})
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const address = email.trim()
    const display = name.trim()
    const next: { email?: string; name?: string } = {}
    if (address.length < 3 || address.length > 254 || !EMAIL.test(address)) {
      next.email = t('people.invite.email.invalid')
    }
    if (display.length > NAME_MAX || /\p{Cc}/u.test(display)) {
      next.name = t('people.invite.name.invalid')
    }
    setError(next)
    if (next.email !== undefined || next.name !== undefined || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    line.clear()
    try {
      const invitation = await action.change(() =>
        action.client.operation('inviteIdentity', {
          body:
            display.length === 0 ? { email: address } : { email: address, displayName: display },
        }),
      )
      // The link goes to the page's state only; the list is read again without it.
      onRevealed(revealedOf(invitation))
      setEmail('')
      setName('')
      line.say(t('people.invite.done'))
      void action.refresh(peopleKeys.identities)
    } catch (failure) {
      line.fail(failure)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <form id="invite-person" className="flex flex-col gap-4" noValidate onSubmit={submit}>
      <Field
        id={`${id}-email`}
        label={t('people.invite.email')}
        description={t('people.invite.email.hint')}
        error={error.email}
      >
        <Input
          id={`${id}-email`}
          type="email"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          maxLength={254}
          required
          value={email}
          aria-invalid={error.email !== undefined}
          aria-describedby={`${id}-email-description`}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Field
        id={`${id}-name`}
        label={t('people.invite.name')}
        description={t('people.invite.name.hint')}
        error={error.name}
      >
        <Input
          id={`${id}-name`}
          autoComplete="off"
          maxLength={NAME_MAX}
          value={name}
          aria-invalid={error.name !== undefined}
          aria-describedby={`${id}-name-description`}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <div>
        <Button type="submit" variant="default" size="small" loading={busy}>
          {t('people.invite.submit')}
        </Button>
      </div>
    </form>
  )
}

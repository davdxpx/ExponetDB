import type { StepUpView } from '@exponetdb/contracts'
import { call } from '../api.ts'
import { formatTime, h, replace } from '../dom.ts'
import { withReauth } from '../reauth.ts'
import { action, type Shell } from '../shell.ts'

/**
 * Confirming a CLI step-up (ADR-0026 §2): the person signed in here is the
 * person whose CLI asked; the page shows which client, which action and
 * which plan hash, and asks for the code the CLI shows. The confirmation
 * needs a fresh passkey or authenticator proof (the server decides the
 * window). A step-up of anybody else reads as not found.
 */
const TITLES: Record<string, string> = {
  'plan.apply': 'Apply a plan',
  'node.enrollment_token.reveal': 'Reveal a node enrollment token once',
}

export async function stepUpPage(ui: Shell): Promise<void> {
  const id = /^#id=(stu_[0-7][0-9A-HJKMNP-TV-Z]{25})$/.exec(location.hash)?.[1]
  if (id === undefined) {
    replace(ui.content, h('p', { id: 'step-up-missing' }, 'Open the link your terminal shows.'))
    return
  }
  const stepUp = await call<StepUpView>('GET', `/api/v1/step-ups/${id}`)
  if (stepUp.state !== 'pending') {
    replace(
      ui.content,
      h(
        'p',
        { id: 'step-up-state' },
        `This confirmation is ${stepUp.state}. Start again from the terminal if needed.`,
      ),
    )
    return
  }
  const code = h('input', {
    name: 'code',
    id: 'step-up-code',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'ABCD-EFGH',
    maxlength: '9',
  })
  replace(
    ui.content,
    h(
      'section',
      { class: 'card', id: 'step-up' },
      h('h2', {}, 'Confirm a command from your terminal'),
      h(
        'dl',
        {},
        h('dt', {}, 'Client'),
        h('dd', { id: 'step-up-client' }, stepUp.clientName ?? 'unknown client'),
        h('dt', {}, 'Action'),
        h('dd', { id: 'step-up-action' }, TITLES[stepUp.action] ?? stepUp.action),
        ...(stepUp.planHash === null
          ? []
          : [h('dt', {}, 'Plan hash'), h('dd', {}, h('code', { class: 'hash' }, stepUp.planHash))]),
        h('dt', {}, 'Expires'),
        h('dd', {}, formatTime(stepUp.expiresAt)),
      ),
      h(
        'p',
        { class: 'hint' },
        'Only confirm a command you started yourself just now. The code must match the one your terminal shows.',
      ),
      h('label', {}, 'Code from the terminal', code),
      h(
        'div',
        { class: 'row' },
        action(
          'Confirm',
          ui,
          async () => {
            const confirmed = await withReauth(() =>
              call<StepUpView>('POST', `/api/v1/step-ups/${id}/confirm`, {
                userCode: code.value.trim(),
              }),
            )
            replace(
              ui.content,
              h(
                'p',
                { id: 'step-up-done' },
                `Confirmed. Return to the terminal; it continues within ${confirmed.receiptExpiresAt === null ? 'a moment' : `until ${formatTime(confirmed.receiptExpiresAt)}`}.`,
              ),
            )
          },
          { class: 'primary' },
        ),
        action('Cancel', ui, async () => {
          await call<StepUpView>('POST', `/api/v1/step-ups/${id}/cancel`, {})
          replace(
            ui.content,
            h('p', { id: 'step-up-canceled' }, 'Canceled. The terminal command stops.'),
          )
        }),
      ),
    ),
  )
}

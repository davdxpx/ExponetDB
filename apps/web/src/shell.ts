import { ApiError, call } from './api.ts'
import { type Child, h, replace } from './dom.ts'
import { loginUrl } from './safe.ts'
import { PasskeyCanceled } from './webauthn.ts'

/**
 * The frame of every page: a header with navigation (when signed in), one
 * live status line, one alert line and the page content. Messages are text
 * only.
 */
export interface Shell {
  readonly content: HTMLElement
  status(text: string): void
  alert(error: unknown): void
  clear(): void
}

export function shell(root: HTMLElement, title: string, signedIn: boolean): Shell {
  const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' })
  const alertLine = h('p', { class: 'alert', role: 'alert' })
  const content = h('section', { class: 'content', 'aria-labelledby': 'page-title' })
  const nav = signedIn
    ? h(
        'nav',
        { 'aria-label': 'Main' },
        h('a', { href: '/account' }, 'Account'),
        h('a', { href: '/approvals' }, 'Approvals'),
        h('a', { href: '/admin/clients' }, 'Clients'),
        h('a', { href: '/admin/service-accounts' }, 'Service accounts'),
        h(
          'button',
          { type: 'button', class: 'link', id: 'sign-out', onclick: () => void signOut() },
          'Sign out',
        ),
      )
    : null
  replace(
    root,
    h('header', {}, h('span', { class: 'product' }, 'ExponetDB'), nav),
    h('h1', { id: 'page-title' }, title),
    status,
    alertLine,
    content,
  )
  document.title = `${title} · ExponetDB`
  return {
    content,
    status: (text) => {
      alertLine.textContent = ''
      status.textContent = text
    },
    alert: (error) => {
      status.textContent = ''
      alertLine.textContent = describe(error)
    },
    clear: () => {
      status.textContent = ''
      alertLine.textContent = ''
    },
  }
}

/** User-facing text for an error: the server's catalog message, or a fixed local one. */
export function describe(error: unknown): string {
  if (error instanceof Error && error.name === 'ReauthCanceled') {
    return 'Canceled. Nothing was changed.'
  }
  if (error instanceof PasskeyCanceled) {
    return 'The passkey prompt was closed or timed out. Try again.'
  }
  if (error instanceof ApiError) {
    if (error.code === 'RATE_LIMITED' && error.retryAfterSeconds !== undefined) {
      return `Too many attempts. Try again in ${Math.ceil(error.retryAfterSeconds)} seconds.`
    }
    return `${error.message} (${error.code})`
  }
  return 'Something went wrong. Reload the page and try again.'
}

/** Leaves for the sign-in page when the session is gone. */
export function isSignedOut(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'UNAUTHENTICATED' || error.code === 'SESSION_EXPIRED')
  )
}

export function toLogin(): void {
  location.assign(loginUrl(location.pathname + location.hash))
}

async function signOut(): Promise<void> {
  try {
    await call('POST', '/auth/logout')
  } catch {
    // Signed out already, or the session expired: the sign-in page follows either way.
  }
  location.assign('/login')
}

/** A button that disables itself while its action runs and reports failures. */
export function action(
  label: string,
  ui: Shell,
  run: () => Promise<void>,
  props: Readonly<Record<string, string>> = {},
): HTMLButtonElement {
  const button = h('button', { type: 'button', ...props }, label)
  button.addEventListener('click', () => {
    button.disabled = true
    ui.clear()
    run()
      .catch((error: unknown) => (isSignedOut(error) ? toLogin() : ui.alert(error)))
      .finally(() => {
        button.disabled = false
      })
  })
  return button
}

/** A form whose submit runs `run` with the form, never navigating. */
export function form(
  ui: Shell,
  props: Readonly<Record<string, string>>,
  run: (form: HTMLFormElement) => Promise<void>,
  ...children: Child[]
): HTMLFormElement {
  const el = h('form', props, ...children)
  el.addEventListener('submit', (event) => {
    event.preventDefault()
    const submit = el.querySelector('button[type="submit"]')
    if (submit instanceof HTMLButtonElement) {
      submit.disabled = true
    }
    ui.clear()
    run(el)
      .catch((error: unknown) => (isSignedOut(error) ? toLogin() : ui.alert(error)))
      .finally(() => {
        if (submit instanceof HTMLButtonElement) {
          submit.disabled = false
        }
      })
  })
  return el
}

export function labeled(label: string, input: HTMLInputElement): HTMLLabelElement {
  return h('label', {}, h('span', {}, label), input)
}

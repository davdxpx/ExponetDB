/**
 * The English message catalog of the Web App (OD-1: English behind typed
 * message keys; a German catalog is another object of the same shape).
 * Sentence case, verbs that name the outcome, no exclamation marks; errors
 * say what failed and what to do next. `{name}` placeholders are filled as
 * text, never as markup.
 */
import { accessMessages } from './messages/access.ts'
import { accountMessages } from './messages/account.ts'
import { oauthMessages } from './messages/oauth.ts'
import { plansMessages } from './messages/plans.ts'
import { targetMessages } from './messages/target.ts'

const core = {
  'app.name': 'ExponetDB',
  'error.network': 'The server could not be reached. Check your connection and try again.',
  'error.unknown': 'Something went wrong. Reload the page and try again.',
  'error.rateLimited': 'Too many attempts. Try again in {seconds} seconds.',
  'error.withCode': '{message} ({code})',
  'error.responseInvalid': 'The server sent an answer the page cannot read. Reload the page.',
  'reauth.canceled': 'Canceled. Nothing was changed.',
  'reauth.title': 'Confirm it is you',
  'reauth.description': 'This action needs a recent confirmation of your identity.',
  'reauth.passkey': 'Confirm with passkey',
  'reauth.code.label': 'Or enter the code from your authenticator app',
  'reauth.code.submit': 'Confirm with code',
  'reauth.cancel': 'Cancel',
  'passkey.canceled': 'The passkey prompt was closed or timed out. Try again.',
  'state.failed': 'Could not read {subject}: {reason}. This does not mean there is no {subject}.',
  'state.stale': 'Last read {age} ago from {source}.',
  'state.partial': 'Partly read. Missing: {missing}.',
  'state.notAvailableYet': '{feature} is not available yet. It arrives with {wave}.',
  'state.notPermitted': 'You do not have permission to see this ({permission}).',
  'state.notSupported': 'Not supported here: {reason}.',
  'state.refresh': 'Refresh',
  'state.retry': 'Try again',
  'session.reading': 'Checking your session',
  'session.readFailed':
    'Could not check your session: {reason} This does not mean you are signed out.',
  'session.leaving': 'Your session ended. Opening the sign-in page.',
  'shell.skip': 'Skip to content',
  'shell.search': 'Search or jump to',
  'shell.navigation': 'Main navigation',
  'shell.sectionMenu': '{section} pages',
  'shell.sectionMenu.resize': 'Resize the section menu',
  'shell.sidebar': 'Sidebar',
  'shell.sidebar.hover': 'Expand on hover',
  'shell.sidebar.open': 'Always open',
  'shell.sidebar.collapsed': 'Collapsed',
  'shell.theme': 'Theme',
  'shell.theme.system': 'Same as the system',
  'shell.theme.light': 'Light',
  'shell.theme.dark': 'Dark',
  'shell.account': 'Account',
  'shell.account.settings': 'Account settings',
  'shell.signOut': 'Sign out',
  'page.notFound.title': 'Page not found',
  'page.notFound.body': 'There is no page at this address.',
  'page.notFound.back': 'Go to the overview',
  'page.overview.title': 'Overview',
  'audit.reason.warning':
    'This reason is kept permanently in the audit log. Do not enter personal data.',
} as const satisfies Readonly<Record<string, string>>

/**
 * The parts of the catalog: the core messages and one module per feature
 * under `messages/` (a feature adds its own module and one line here). A key
 * defined in two parts fails `test/i18n/catalog-parts.test.ts`.
 */
export const CATALOG_PARTS = {
  core,
  target: targetMessages,
  account: accountMessages,
  oauth: oauthMessages,
  access: accessMessages,
  plans: plansMessages,
} as const

export const en = {
  ...core,
  ...targetMessages,
  ...accountMessages,
  ...oauthMessages,
  ...accessMessages,
  ...plansMessages,
} as const

export type MessageKey = keyof typeof en
export type Catalog = { readonly [K in MessageKey]: string }

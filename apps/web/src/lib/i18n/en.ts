/**
 * The English message catalog of the Web App (OD-1: English behind typed
 * message keys; a German catalog is another object of the same shape).
 * Sentence case, verbs that name the outcome, no exclamation marks; errors
 * say what failed and what to do next. `{name}` placeholders are filled as
 * text, never as markup.
 */
export const en = {
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
  'audit.reason.warning':
    'This reason is kept permanently in the audit log. Do not enter personal data.',
} as const satisfies Readonly<Record<string, string>>

export type MessageKey = keyof typeof en
export type Catalog = { readonly [K in MessageKey]: string }

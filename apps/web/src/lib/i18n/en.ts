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
  // Target layout (Phase 7)
  'target.read.what': 'Target',
  'target.health.what': 'Target health',
  'target.feature.default': 'This page',
  'target.bar.label': 'Target',
  'target.bar.environment': 'Environment',
  'target.tier.unknown': 'Tier unknown',
  'target.nav.label': 'Target sections',
  'target.commands.section': 'Switch environment',
  'target.command.switch': 'Switch to {environment}',
  'target.switcher.loading': 'Loading environments',
  'target.switcher.failed':
    'Could not read the environments of this project: {reason} This does not mean there are no other environments.',
  'target.switcher.empty': 'The read succeeded and found no environments for this project.',
  'target.switcher.stale': 'Showing an earlier read of the environments, observed',
  'target.switcher.partial': 'Showing part of the environments. {missing}',
  'target.switcher.missing.more': 'More environments exist than one read returns.',
  'target.switcher.missing.unreadable': 'Some environments have a path the page cannot show.',
  'target.switcher.current': 'Current environment',
  'target.lifecycle.registered': 'Registered',
  'target.lifecycle.suspended': 'Suspended',
  'target.lifecycle.decommissioned': 'Decommissioned',
  'target.schema.kind': 'Object kind: {kind}',
  'target.placeholder.reason': 'This page of the Web App is not built yet.',
  'target.state.observation': 'Source: {source}. Observed',
  'target.state.observationNoSource': 'Source: not reported. Observed',
  'target.state.readHealth': 'Read health again',
  'target.state.decommissioned.title': 'This target is decommissioned',
  'target.state.decommissioned.body':
    'ExponetDB no longer manages it, and its path is never reused. Its history stays in the audit log.',
  'target.state.decommissioned.action': 'Go to databases',
  'target.state.suspended.title': 'This target is suspended',
  'target.state.suspended.body':
    'Writes are blocked until a person resumes it. The reason is in the audit log.',
  'target.state.suspended.action': 'Open the audit log',
  'target.state.wave9.reason': 'Its data comes from a part of ExponetDB that arrives with Wave 9.',
  'target.state.od21.reason':
    'It waits for the owner decision on the notification channel (OD-21).',
  'target.state.permission.what': 'This page',
  'target.state.noNode.title': 'Not supported on this target',
  'target.state.noNode.body':
    '{feature} needs a node agent on the cluster. The cluster of this target is managed outside ExponetDB and has none.',
  'target.state.unreachable.title': 'The target is unreachable',
  'target.state.unreachable.body':
    'ExponetDB could not reach this database on any registered path in its latest sample. This page reads samples and does not probe.',
  'target.state.unreachable.nodeAlive':
    'The node agent on its host is alive, so the problem is likely the database, its credentials or the network path to it.',
  'target.state.unreachable.nodeDown':
    'The node agent is not online either. ExponetDB cannot tell whether the network or the host failed.',
  'target.state.unreachable.noNode':
    'The cluster has no node agent, so ExponetDB cannot see its host.',
  'target.state.cannotTell.title': 'Cannot tell whether the target is reachable',
  'target.state.cannotTell.failed':
    'Could not read the health of this target: {reason} This does not mean it is unreachable.',
  'target.state.cannotTell.missing':
    'This page has no reading of the health of the target. This does not mean it is unreachable.',
  'target.state.cannotTell.unknown':
    'ExponetDB has no usable observation of this target. The database may be fine.',
  'target.state.nodeCannotTell.title': 'Cannot tell whether the node is online',
  'target.state.nodeCannotTell.failed':
    'Could not read the health of this target: {reason} This does not mean the node is offline.',
  'target.state.nodeCannotTell.missing':
    'This page has no reading of the node state. This does not mean the node is offline.',
  'target.state.nodeCannotTell.unknown':
    'ExponetDB has no usable observation of the node agent. The node may be fine.',
  'target.state.nodeOffline.title': 'The node is not online',
  'target.state.nodeOffline.body':
    'The node agent of this target reports {state}, so host actions are unavailable.',
  'target.unknown.none': 'No reason was reported.',
  'target.unknown.other': 'The reason code is {code}.',
  'target.unknown.control_plane_degraded': "ExponetDB's own sampler is not running.",
  'target.unknown.never_sampled': 'The target has not been sampled yet.',
  'target.unknown.sampler_lagging': 'The latest sample is too old.',
  'target.unknown.no_endpoint': 'The target has no registered endpoint.',
  'target.unknown.no_placement': 'The target has no placement.',
  'target.unknown.observer_credential_missing': 'The observer credential is not set.',
  'target.unknown.no_active_endpoint': 'The target has no active endpoint.',
} as const satisfies Readonly<Record<string, string>>

export type MessageKey = keyof typeof en
export type Catalog = { readonly [K in MessageKey]: string }

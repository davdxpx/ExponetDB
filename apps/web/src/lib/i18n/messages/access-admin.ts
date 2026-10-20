/**
 * Messages of People, Roles and Connected applications
 * (`src/features/access/{people,roles,connected-apps}-page.tsx`), and the
 * OD-5 registration rules on the OAuth clients page (both modes and the
 * one this installation runs, read from `GET /installation`).
 */
export const accessAdminMessages = {
  // ----- OAuth client registration (OD-5, revised 2026-10-13) -----
  'oauthRegistration.open':
    'Open (the default): a new MCP client that registers itself (DCR) or presents a metadata document (CIMD) is approved automatically, so connecting one needs no administrator. Every person still signs in and consents on this installation’s own page before a client gets any access, and production changes by agents still wait for a human approval. A rejected or disabled client is never approved automatically.',
  'oauthRegistration.review':
    'Review: a new client waits on this page until an administrator approves the exact client (its client ID and the fingerprint of its metadata). Every person still consents as well.',
  'oauthRegistration.setting':
    'The mode is set on the server by EXPONETDB_OAUTH_CLIENT_REGISTRATION (open or review). A client marked "Automatically, under open registration" shows that open registration admitted it.',
  'oauthRegistration.current.loading': 'Reading which mode this installation uses…',
  'oauthRegistration.current.open': 'This installation uses open registration.',
  'oauthRegistration.current.review': 'This installation uses review registration.',
  'oauthRegistration.current.unreported':
    'This installation’s server does not report its mode. Ask an operator for the value of EXPONETDB_OAUTH_CLIENT_REGISTRATION.',
  'oauthRegistration.current.failed':
    'Could not read which mode this installation uses: {reason}. This does not mean either mode.',

  // ----- People -----
  'people.title': 'People',
  'people.description':
    'The people who sign in to this installation, their roles and where those roles apply. A person holds what their role bindings give, nothing more. Service accounts are on their own page.',
  'people.list': 'People',
  'people.what': 'People list',
  'people.more':
    'Only the first {count} identities are shown. Others exist but are not listed here.',
  'people.empty.title': 'No people yet',
  'people.empty.body': 'The read succeeded and found no people. Invite one to start.',
  'people.name': 'Name',
  'people.email': 'Address',
  'people.email.none': 'None (erased)',
  'people.id': 'Identity ID',
  'people.factors': 'Sign-in factors',
  'people.factors.passkeys': 'Passkeys: {count}',
  'people.factors.password': 'Password: set',
  'people.factors.noPassword': 'Password: not set',
  'people.factors.totp': 'Authenticator app: set',
  'people.factors.noTotp': 'Authenticator app: not set',
  'people.factors.recovery': 'Recovery codes left: {count}',
  'people.created': 'Created',
  'people.activated': 'Activated',
  'people.activated.never': 'Not yet',
  'people.recoveryRequired': 'Recovery required',
  'people.state.invited': 'Invited',
  'people.state.active': 'Active',
  'people.state.disabled': 'Disabled',
  'people.state.erased': 'Erased',
  'people.bindings.title': 'Roles',
  'people.bindings.none': 'No role. This person can sign in but see or change nothing.',
  'people.bindings.unknown':
    'The role bindings could not be read. This does not mean this person has no role.',
  'people.bindings.failed.title': 'Role bindings could not be read',
  'people.bindings.failed.body':
    'Could not read the role bindings: {reason} The people below are shown without their roles; this does not mean they have none.',
  'people.bindings.partial.title': 'Some role bindings are not shown',
  'people.bindings.partial.body':
    'Only the first {count} role bindings were read. A person without a listed role may still hold one.',
  'people.scope.global': 'Installation',
  'people.scope.product': 'Product',
  'people.scope.project': 'Project',
  'people.scope.environment': 'Environment',
  'people.scope.target': 'Target',
  'people.scope.withId': '{kind} {id}',
  'people.binding.form': 'Plan a role binding',
  'people.binding.role': 'Role',
  'people.binding.scope': 'Applies to',
  'people.binding.scopeId': '{kind} ID',
  'people.binding.scopeId.hint': 'The ID starts with {prefix}.',
  'people.binding.scopeId.invalid':
    'Enter an ID that starts with {prefix} followed by 26 characters.',
  'people.binding.submit': 'Create plan to bind role',
  'people.binding.remove': 'Remove',
  'people.binding.remove.label': 'Remove role {role} at {scope}',
  'people.binding.remove.title': 'Plan removing this role binding',
  'people.binding.remove.body':
    'This creates a plan to remove the role. Nothing changes until the plan is approved and applied; its review page opens next.',
  'people.binding.remove.action': 'Create plan to remove role',
  'people.reason.label': 'Reason (optional)',
  'people.invite.title': 'Invite a person',
  'people.invite.description':
    'The person gets a one-time link to set up a passkey, a password and an authenticator app. They hold no role until you bind one.',
  'people.invite.email': 'Address',
  'people.invite.email.hint':
    'Used to tell the person apart and, once a channel exists, to send the link.',
  'people.invite.email.invalid': 'Enter an address like name@example.com.',
  'people.invite.name': 'Display name (optional)',
  'people.invite.name.hint': 'Shown to administrators. At most 128 characters.',
  'people.invite.name.invalid': 'Use at most 128 characters and no control characters.',
  'people.invite.submit': 'Invite person',
  'people.invite.done': 'Invited. Pass the link on now; it is shown only once.',
  'people.invite.link.region': 'Invitation link',
  'people.invite.link.title': 'Copy the invitation link now',
  'people.invite.link.body':
    'This link is shown once. Anyone with it can set up this identity until it expires, so pass it only to the person, over a channel you trust.',
  'people.invite.link.expires': 'Expires',
  'people.invite.link.copy': 'Copy link',
  'people.invite.link.copied': 'Link copied.',
  'people.invite.link.copyFailed': 'Could not copy. Select the link and copy it yourself.',
  'people.invite.link.hide': 'Hide link',
  'people.invite.delivery.sent': 'It was also sent by e-mail.',
  'people.invite.delivery.failed': 'Sending it by e-mail failed. Pass the link on yourself.',
  'people.invite.delivery.notConfigured':
    'No e-mail channel is configured, so nothing was sent. Pass the link on yourself.',
  'people.reissue': 'Issue new invitation link',
  'people.reissue.title': 'Issue a new invitation link',
  'people.reissue.body':
    'The current link stops working at once and a new one is shown once on this page.',
  'people.reissue.action': 'Issue new link',
  'people.reissue.done': 'A new invitation link was issued. The old one no longer works.',
  'people.disable': 'Disable',
  'people.disable.title': 'Disable this person',
  'people.disable.body':
    'Every session, sign-in ceremony and link of this person ends at once. Their roles stay recorded. Enabling them again is a plan that needs approval.',
  'people.disable.action': 'Disable person',
  'people.disable.done': 'Disabled. Every session of this person has ended.',
  'people.enable': 'Plan enabling',
  'people.enable.title': 'Plan enabling this person',
  'people.enable.body':
    'This creates a plan to enable the person again. Nothing changes until the plan is approved and applied; its review page opens next.',
  'people.enable.action': 'Create plan to enable',
  'people.erase': 'Plan erasure',
  'people.erase.title': 'Plan erasing this person',
  'people.erase.body':
    'This creates a critical plan to erase the identity: its address, name and factors are removed for good and its audit events keep only a pseudonym. Nothing changes until the plan is approved and applied; its review page opens next.',
  'people.erase.action': 'Create erasure plan',

  // ----- Roles -----
  'roles.title': 'Roles',
  'roles.description':
    'The built-in roles, what each is for and the permissions it carries, and who holds each role where. Roles are fixed per release; bindings change through plans.',
  'roles.list': 'Roles',
  'roles.what': 'Role catalog',
  'roles.empty.title': 'No roles',
  'roles.empty.body': 'The read succeeded and listed no roles.',
  'roles.bindings.what': 'Role bindings',
  'roles.bindings.more':
    'Only the first {count} role bindings are shown. A role without a listed holder may still have one.',
  'roles.bindHint': 'Role bindings are planned per person.',
  'roles.bindHint.link': 'Plan a binding on the People page',
  'roles.permissions': 'Permissions',
  'roles.holders': 'Held by',
  'roles.holders.none': 'Nobody holds this role.',
  'roles.holders.unknown': 'Who holds this role could not be read.',
  'roles.role.owner': 'Owner',
  'roles.role.admin': 'Administrator',
  'roles.role.operator': 'Operator',
  'roles.role.developer': 'Developer',
  'roles.role.viewer': 'Viewer',
  'roles.role.auditor': 'Auditor',

  // ----- Connected applications (administrators) -----
  'connectedApps.title': 'Connected applications',
  'connectedApps.description':
    'Every grant a person or service account gave a client: what the client may do, where, until when, and when it was last used. Your own grants are on your account page.',
  'connectedApps.list': 'Grants',
  'connectedApps.what': 'Grant list',
  'connectedApps.more':
    'Only the first {count} grants are shown. Others exist but are not listed here.',
  'connectedApps.empty.title': 'No grants',
  'connectedApps.empty.body': 'The read succeeded and found no grants with this filter.',
  'connectedApps.filter': 'Show',
  'connectedApps.filter.active': 'Active grants',
  'connectedApps.filter.revoked': 'Revoked grants',
  'connectedApps.filter.expired': 'Expired grants',
  'connectedApps.filter.all': 'All grants',
  'connectedApps.client': 'Client name',
  'connectedApps.clientId': 'Client ID',
  'connectedApps.person': 'For',
  'connectedApps.kind': 'Kind',
  'connectedApps.kind.delegated': 'Acts for a person',
  'connectedApps.kind.machine': 'Machine grant of a service account',
  'connectedApps.resource': 'Resource',
  'connectedApps.resource.mcp': 'MCP',
  'connectedApps.resource.api': 'REST API',
  'connectedApps.scopes': 'Scopes',
  'connectedApps.tiers': 'Tiers',
  'connectedApps.targets': 'Targets',
  'connectedApps.targets.all': 'Every target the roles reach',
  'connectedApps.consent': 'Consent',
  'connectedApps.consent.none': 'None recorded',
  'connectedApps.expires': 'Expires',
  'connectedApps.lastUsed': 'Last used',
  'connectedApps.lastUsed.none':
    'No use recorded. This does not mean it was never used: the record began with Wave 8.',
  'connectedApps.revoked': 'Revoked',
  'connectedApps.use.read': 'Read',
  'connectedApps.use.plan': 'Plan',
  'connectedApps.use.apply': 'Apply',
  'connectedApps.use.data': 'Data read',
  'connectedApps.use.rest': 'REST API',
  'connectedApps.state.active': 'Active',
  'connectedApps.state.revoked': 'Revoked',
  'connectedApps.state.expired': 'Expired',
  'connectedApps.revoke': 'Revoke',
  'connectedApps.revoke.title': 'Revoke this grant',
  'connectedApps.revoke.body':
    'Every access and refresh token of this grant stops working at once. The client must ask the person for a new consent to act again.',
  'connectedApps.revoke.action': 'Revoke grant',
  'connectedApps.revoke.done': 'Revoked. Every token of this grant has stopped working.',
} as const satisfies Readonly<Record<string, string>>

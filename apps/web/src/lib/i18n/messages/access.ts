/**
 * Messages of access administration (`src/features/access/`): OAuth clients
 * (oauth.md §3, OD-5 as revised on 2026-10-13), service accounts, their
 * keys, machine grants and API keys (identity.md §5).
 */
export const accessMessages = {
  'access.manage.missing': 'You can see this list. Changing it needs the permission access.manage.',

  // ----- choices by name in front of a typed ID -----
  'choice.loading': 'Loading {what}',
  'choice.failed':
    'Could not read {what}: {reason} This does not mean the list is empty. You can enter the ID instead.',
  'choice.notPermitted':
    'You do not have access to {what}. It needs the permission {permission}. You can enter the ID instead.',
  'choice.retry': 'Try again',
  'choice.stale': 'Showing an earlier read of {what}.',
  'choice.refresh': 'Refresh',
  'choice.partial': 'Only the first {count} are listed. Enter the ID of any other one.',
  'choice.empty': 'The read succeeded and {what} is empty. You can enter an ID if you know one.',
  'choice.what.products': 'Product list',
  'choice.what.projects': 'Project list',
  'choice.what.environments': 'Environment list',
  'choice.what.targets': 'Target list',
  'choice.what.people': 'Person list',

  // ----- a filter that leaves nothing of a list that was read -----
  'noMatch.title': 'No match',
  'noMatch.body': 'The read succeeded, but nothing fits these filters.',
  'noMatch.reset': 'Reset filters',

  // ----- OAuth clients -----
  'access.clients.title': 'OAuth clients',
  'access.clients.description':
    'Applications that act for a person, such as MCP clients and the CLI, or for a service account. A client never decides what it may do: the consent of a person and their roles do.',
  'access.clients.registration.title': 'Open registration is the default',
  'access.clients.list': 'OAuth clients',
  'access.clients.what': 'OAuth client list',
  'access.clients.empty.title': 'No OAuth clients yet',
  'access.clients.empty.body':
    'The read succeeded and found no clients. A client appears here when it registers or when you add it by its metadata document.',
  'access.clients.more': 'More clients exist than one read returns; the first {count} are shown.',
  'access.clients.filter': 'State',
  'access.clients.filter.all': 'All states',
  'access.clients.pending.one': '1 client waits for review.',
  'access.clients.pending.many': '{count} clients wait for review.',
  'access.clients.pending.atLeast':
    'At least {count} clients wait for review. The list is cut, so more may wait.',

  'access.cimd.title': 'Add a client by its metadata document',
  'access.cimd.description':
    'ExponetDB fetches the Client ID Metadata Document from this exact address and records the client. Nothing else on that host is trusted.',
  'access.cimd.label': 'Client ID Metadata Document URL (exact)',
  'access.cimd.hint': 'The https address that is also the client_id, exactly, without a wildcard.',
  'access.cimd.invalid': 'Enter the exact https address of the metadata document.',
  'access.cimd.submit': 'Fetch for review',
  'access.cimd.done.pending': 'The client was fetched and waits for review.',
  'access.cimd.done.recorded': 'The client was fetched and recorded.',

  'access.client.name': 'Client name',
  'access.client.firstParty': 'First party',
  'access.client.state.pending': 'Waiting for review',
  'access.client.state.active': 'Active',
  'access.client.state.rejected': 'Rejected',
  'access.client.state.disabled': 'Disabled',
  'access.client.clientId': 'Client ID',
  'access.client.kind': 'Kind',
  'access.client.kind.value': '{registration}, {kind}, {auth}',
  'access.client.registration.firstParty': 'First party',
  'access.client.registration.preRegistered': 'Pre-registered',
  'access.client.registration.cimd': 'CIMD',
  'access.client.registration.dcr': 'DCR',
  'access.client.type.web': 'Web App',
  'access.client.type.cli': 'CLI',
  'access.client.type.mcp': 'MCP client',
  'access.client.type.ci': 'Service account client',
  'access.client.auth.none': 'Public client without a secret',
  'access.client.auth.privateKeyJwt': 'Private key JWT',
  'access.client.redirectHosts': 'Redirect hosts',
  'access.client.redirectUris': 'Redirect URIs',
  'access.client.none': 'None',
  'access.client.fingerprint': 'Metadata fingerprint',
  'access.client.requester': 'Requester (pseudonym)',
  'access.client.approved': 'Approved',
  'access.client.approvedAutomatically':
    'Automatically, under open registration. Every person still consents.',
  'access.client.pendingExpires': 'Expires unless approved',
  'access.client.metadataFetched': 'Metadata fetched',
  'access.client.registered': 'Registered',
  'access.client.stateSince': 'State since',
  'access.client.lastUsed': 'Last used',
  'access.client.lastUsed.notReported': 'Not reported by this server.',
  'access.client.lastUsed.none':
    'No use recorded. That does not mean the client was never used: recording began with its deployment, and a write can be lost.',
  'access.client.use.activeGrants.one': '1 active grant',
  'access.client.use.activeGrants.many': '{count} active grants',
  'access.client.use.activeGrants.notReported': 'Active grants: not reported by this server.',
  'access.client.use.source':
    'The latest use covers every grant of this client, revoked and expired ones too.',

  'access.client.approve': 'Approve this exact client',
  'access.client.approve.title': 'Approve this exact client',
  'access.client.approve.body':
    'You approve this client_id with exactly these redirect URIs and this metadata fingerprint. If any of them changes, the client needs a new review. Every person still consents before it gets access.',
  'access.client.approve.done': 'Approved.',
  'access.client.reject': 'Reject',
  'access.client.reject.title': 'Reject this client',
  'access.client.reject.body':
    'The client cannot sign anyone in. It is never approved automatically again; only an administrator can approve it later.',
  'access.client.reject.action': 'Reject client',
  'access.client.reject.done': 'Rejected.',
  'access.client.disable': 'Disable',
  'access.client.disable.title': 'Disable this client',
  'access.client.disable.body':
    'Every grant and token of this client ends at once, for every person. It is never approved automatically again; only an administrator can approve it later, and people must consent again.',
  'access.client.disable.action': 'Disable client',
  'access.client.disable.done': 'Disabled; its grants ended.',
  'access.client.refresh': 'Fetch metadata again',
  'access.client.refresh.done': 'Metadata fetched.',

  // ----- service accounts -----
  'access.services.title': 'Service accounts',
  'access.services.description':
    'Identities for CI and backends. A service account has no password and no passkey: it signs in with its own client (private key JWT) or with an API key.',
  'access.services.ceiling.title': 'Scopes never add a permission',
  'access.services.ceiling.body':
    'A service account can do only what its roles allow. Scopes, tiers and lifetimes narrow that further and never widen it. A service account without a role is refused everything.',
  'access.services.list': 'Service accounts',
  'access.services.overview': 'API key overview',
  'access.services.what': 'Service account list',
  'access.services.empty.title': 'No service accounts yet',
  'access.services.empty.body': 'The read succeeded and found no service accounts.',
  'access.services.more':
    'More service accounts exist than one read returns; the first {count} are shown.',
  'access.services.create.title': 'Create a service account',
  'access.services.create.description':
    'It starts with no role and no credential, and you are its responsible person. Give it a role through an access plan, then a key.',
  'access.services.create.name': 'Name',
  'access.services.create.hint': 'Shown to administrators and in the audit log.',
  'access.services.create.invalid':
    'Enter a name of 1 to 128 characters without control characters.',
  'access.services.create.submit': 'Create service account',
  'access.services.create.done': 'Service account created. It has no role and no credential yet.',

  'access.service.name': 'Service account name',
  'access.service.state.invited': 'Invited',
  'access.service.state.active': 'Active',
  'access.service.state.disabled': 'Disabled',
  'access.service.state.erased': 'Erased',
  'access.service.label': 'Audit label',
  'access.service.responsible': 'Responsible person',
  'access.service.created': 'Created',
  'access.service.client': 'Client',
  'access.service.client.none': 'None yet',
  'access.service.keys': 'Public keys',
  'access.service.keys.none': 'None',

  'access.service.keys.title': 'Public keys',
  'access.service.keys.description':
    'The service account signs its token requests with its private key, which stays with it. Paste only the public keys.',
  'access.service.keys.label': 'Public keys (JWKS JSON; never a private key)',
  'access.service.keys.hint':
    'A JWKS with one to four keys: EC P-256 or P-384, Ed25519 or RSA, each with a kid.',
  'access.service.keys.required': 'Paste at least one public key.',
  'access.service.keys.json': 'The keys are not valid JSON. Paste the JWKS as it is.',
  'access.service.keys.shape':
    'These are not public signing keys ExponetDB accepts: EC P-256 or P-384, Ed25519 or RSA, each with a kid and nothing else.',
  'access.service.keys.private':
    'This is a private key. Nothing was sent, and the field was cleared. Paste only the public keys.',
  'access.service.keys.register': 'Register client',
  'access.service.keys.replace': 'Replace keys',
  'access.service.keys.registered': 'Client registered.',
  'access.service.keys.replaced': 'Keys replaced.',
  'access.service.keys.replace.title': 'Replace the public keys',
  'access.service.keys.replace.body':
    'The new set replaces every key the client has. A token request signed with a key that is not in it is refused from now on. To rotate without a gap, keep the old key in the set until the new one is in use.',
  'access.service.keys.replace.action': 'Replace keys',

  'access.service.grants.title': 'Machine grant',
  'access.service.grants.description':
    'What the client may ask for with client credentials, through the REST API only. One grant is active at a time; a new one replaces it.',
  'access.service.grants.none': 'No machine grant yet.',
  'access.service.grants.needsClient': 'Register the client with its public keys first.',
  'access.service.grant.line.active': '{scopes} ({tiers}), active, until {until}.',
  'access.service.grant.line.revoked': '{scopes} ({tiers}), revoked, until {until}.',
  'access.service.grant.line.expired': '{scopes} ({tiers}), expired, until {until}.',
  'access.service.grant.submit': 'Create machine grant',
  'access.service.grant.done': 'Machine grant created; any earlier one ended.',
  'access.service.grant.replace.title': 'Replace the machine grant',
  'access.service.grant.replace.body':
    'The active machine grant ends when the new one is created. Tokens the client asks for afterwards carry only the new authority.',
  'access.service.grant.replace.action': 'Replace machine grant',

  'access.service.apiKeys.title': 'API keys',
  'access.service.apiKeys.description':
    'An API key is shown once, when it is created, and ExponetDB keeps only a hash of it. It works for the REST API until it expires or is revoked.',
  'access.service.apiKeys.none': 'No API keys yet.',
  'access.service.apiKey.name': 'API key label',
  'access.service.apiKey.line.active': '{scopes}, active, until {until}.',
  'access.service.apiKey.line.revoked': '{scopes}, revoked, until {until}.',
  'access.service.apiKey.line.expired': '{scopes}, expired, until {until}.',
  'access.service.apiKey.lastUsed': 'Last used {time}.',
  'access.service.apiKey.revoke': 'Revoke',
  'access.service.apiKey.revoke.label': 'Revoke API key {key}',
  'access.service.apiKey.revoke.title': 'Revoke this API key',
  'access.service.apiKey.revoke.body':
    'The key stops working at once. This cannot be undone; a new key is a new secret.',
  'access.service.apiKey.revoke.action': 'Revoke API key',
  'access.service.apiKey.revoke.done': 'API key revoked.',
  'access.service.apiKey.submit': 'Create API key',
  'access.service.apiKey.done': 'API key created. Copy it now; it is shown only this once.',

  'access.service.lifecycle.title': 'Account',
  'access.service.lifecycle.description':
    'Disabling stops the account, its API keys and its machine grant at once and is audited. Enabling it again and erasing it are plans that need approval.',
  'access.service.disable': 'Disable',
  'access.service.disable.title': 'Disable this service account',
  'access.service.disable.body':
    'The account, its API keys and its machine grant stop working at once. They stay recorded. Enabling the account again is a plan that needs approval.',
  'access.service.disable.action': 'Disable service account',
  'access.service.disable.done': 'Disabled. Its API keys and machine grant no longer work.',
  'access.service.enable': 'Plan enabling',
  'access.service.enable.title': 'Plan enabling this service account',
  'access.service.enable.body':
    'This creates a plan to enable the service account again. Nothing changes until the plan is approved and applied; its review page opens next.',
  'access.service.enable.action': 'Create plan to enable',
  'access.service.erase': 'Plan erasure',
  'access.service.erase.title': 'Plan erasing this service account',
  'access.service.erase.body':
    'This creates a critical plan to erase the service account for good: its name is removed and its audit events keep only a pseudonym. Nothing changes until the plan is approved and applied; its review page opens next.',
  'access.service.erase.action': 'Create erasure plan',
  'access.service.erase.typed': 'The account name',
  'access.service.grant.revoke': 'Revoke',
  'access.service.grant.revoke.label': 'Revoke machine grant {id}',
  'access.service.grant.revoke.title': 'Revoke this machine grant',
  'access.service.grant.revoke.body':
    'Every token the client got with this grant stops working at once. A new machine grant is a new authority that someone has to create.',
  'access.service.grant.revoke.action': 'Revoke machine grant',
  'access.service.grant.revoke.done':
    'Machine grant revoked. Every token of this grant has stopped working.',

  'access.apiKeys.overview.title': 'All API keys',
  'access.apiKeys.overview.description':
    'Every API key of every service account: its scopes, where it may act, when it was last used and when it expires. A key’s secret is never shown again.',
  'access.apiKeys.what': 'API key list',
  'access.apiKeys.more':
    'Only the first {count} API keys are shown. Others exist but are not listed here.',
  'access.apiKeys.empty.title': 'No API keys yet',
  'access.apiKeys.empty.body': 'The read succeeded and found no API keys.',
  'access.apiKeys.filter': 'State',
  'access.apiKeys.filter.all': 'All states',
  'access.apiKeys.filter.active': 'Active',
  'access.apiKeys.filter.revoked': 'Revoked',
  'access.apiKeys.filter.expired': 'Expired',
  'access.apiKeys.state.active': 'Active',
  'access.apiKeys.state.revoked': 'Revoked',
  'access.apiKeys.state.expired': 'Expired',
  'access.apiKeys.count': 'Showing {shown} of {total} API keys.',
  'access.apiKeys.caption': 'API keys of all service accounts',
  'access.apiKeys.column.account': 'Service account',
  'access.apiKeys.column.key': 'Key',
  'access.apiKeys.column.scopes': 'Scopes',
  'access.apiKeys.column.targets': 'Where it may act',
  'access.apiKeys.column.state': 'State',
  'access.apiKeys.column.lastUsed': 'Last used',
  'access.apiKeys.column.expires': 'Expires',
  'access.apiKeys.neverUsed': 'Never used',
  'access.apiKeys.targets.all': 'All targets the roles reach',
  'access.apiKeys.targets.one': 'Only 1 target',
  'access.apiKeys.targets.many': 'Only {count} targets',
  'access.apiKeys.badge.expiresSoon': 'Expires in under 14 days',
  'access.apiKeys.badge.unused': 'Not used for 30 days',
  'access.apiKeys.account.name': 'Service account name',
  'access.apiKeys.target.path': 'Target path',

  'access.secret.region': 'New API key',
  'access.secret.title': 'Copy the key now. It is shown only this once.',
  'access.secret.body':
    'ExponetDB keeps only a hash of it. Store it in your secret manager; if it is lost, revoke it and create a new one.',
  'access.secret.copy': 'Copy key',
  'access.secret.copied': 'API key copied',
  'access.secret.copyFailed': 'Could not copy to the clipboard. Select the key and copy it.',
  'access.secret.hide': 'Hide the key',

  // ----- the authority of a machine grant or an API key -----
  'access.authority.summary': 'Scopes: {scopes}. Tiers: {tiers}. Lifetime: {days} days.',
  'access.authority.summary.noDays': 'Scopes: {scopes}. Tiers: {tiers}. Lifetime: not set.',
  'access.authority.none': 'None',
  'access.authority.edit': 'Change scopes and limits',
  'access.authority.hide': 'Hide scopes and limits',
  'access.authority.scopes': 'Scopes',
  'access.authority.scopes.description':
    'A ceiling, never a permission: the service account can use a scope only where its roles allow it.',
  'access.authority.effect.read': 'Reads',
  'access.authority.effect.controlRecord': 'Records plans or checks, changes nothing',
  'access.authority.effect.consequential': 'Changes',
  'access.authority.tiers': 'Tiers',
  'access.authority.tier.nonprod': 'Non-production',
  'access.authority.tier.prod': 'Production',
  'access.authority.production': 'I give this service account production write authority',
  'access.authority.production.description':
    'Needed for a scope that can change something on production. It is listed as a standing finding.',
  'access.authority.days': 'Lifetime in days (at most {max})',
  'access.authority.label': 'Label (optional)',
  'access.authority.label.description': 'Shown in this list instead of the key id.',
  'access.restriction.tiers': 'Tiers: {tiers}.',
  'access.restriction.list.one': 'Targets: limited to 1 target ({ids}).',
  'access.restriction.list.many': 'Targets: limited to {count} targets ({ids}).',
  'access.restriction.more': '{ids}, and {count} more',
  'access.authority.targets': 'Limit to targets',
  'access.authority.targets.description':
    'A limit on top of the roles, never more than they allow. Without one, the authority reaches every target the roles reach.',
  'access.authority.targets.all': 'All targets the roles reach',
  'access.authority.targets.list': 'Only the targets I choose',
  'access.authority.targets.choose': 'Targets it may use',
  'access.authority.targets.count': '{count} of {max} targets chosen.',
  'access.authority.targets.search': 'Search targets',
  'access.authority.targets.noMatch': 'No match. No listed target fits this search.',
  'access.authority.targets.clearSearch': 'Clear search',
  'access.authority.targets.path': 'Target path',
  'access.authority.targets.unlisted': 'Chosen, but not in the list above:',
  'access.authority.targets.remove': 'Remove target {id}',
  'access.authority.targets.removeAction': 'Remove',
  'access.authority.targets.tierMismatch':
    '{path} is {tier}, but that tier is not chosen above, so this authority cannot use it.',
  'access.authority.targets.add': 'Add a target by its ID',
  'access.authority.targets.addAction': 'Add target',
  'access.authority.targets.atMost': 'At most {max} targets can be chosen.',
  'access.authority.summary.targets.all': 'Targets: all the roles reach.',
  'access.authority.summary.targets.list': 'Targets: only the {count} chosen.',
  'access.authority.warn.productionAll':
    'Production is allowed for every target the roles reach. Limit it to the targets it needs.',
  'access.authority.error.targets': 'Choose from 1 to {max} targets, or allow all targets.',
  'access.authority.error.scopes': 'Choose at least one scope.',
  'access.authority.error.tiers': 'Choose at least one tier.',
  'access.authority.error.tierOf': 'The scope {scope} needs the tier {tier}.',
  'access.authority.error.production':
    'Confirm that you give production write authority, or leave production out.',
  'access.authority.error.days': 'Enter a whole number of days from 1 to {max}.',
  'access.authority.error.label': 'Use at most 64 characters without control characters.',
} as const satisfies Readonly<Record<string, string>>

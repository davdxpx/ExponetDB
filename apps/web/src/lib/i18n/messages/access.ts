/**
 * Messages of access administration (`src/features/access/`): OAuth clients
 * (oauth.md §3, OD-5 as revised on 2026-10-13), service accounts, their
 * keys, machine grants and API keys (identity.md §5).
 */
export const accessMessages = {
  'access.manage.missing': 'You can see this list. Changing it needs the permission access.manage.',

  // ----- OAuth clients -----
  'access.clients.title': 'OAuth clients',
  'access.clients.description':
    'Applications that act for a person, such as MCP clients and the CLI, or for a service account. A client never decides what it may do: the consent of a person and their roles do.',
  'access.clients.registration.title': 'Open registration is the default',
  'access.clients.registration.body':
    'A new MCP client that registers itself (DCR) or presents a metadata document (CIMD) is approved automatically, so connecting one needs no administrator. Every person still signs in and consents on this installation’s own page before a client gets any access, and production changes by agents still wait for a human approval. An installation set to review new clients keeps them here until you approve the exact client. A rejected or disabled client is never approved automatically.',
  'access.clients.list': 'OAuth clients',
  'access.clients.what': 'OAuth client list',
  'access.clients.empty.title': 'No OAuth clients yet',
  'access.clients.empty.body':
    'The read succeeded and found no clients. A client appears here when it registers or when you add it by its metadata document.',
  'access.clients.more': 'More clients exist than one read returns; the first {count} are shown.',

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
  'access.client.lastUsed.unreported': 'Not reported by the server yet',

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
  'access.authority.error.scopes': 'Choose at least one scope.',
  'access.authority.error.tiers': 'Choose at least one tier.',
  'access.authority.error.tierOf': 'The scope {scope} needs the tier {tier}.',
  'access.authority.error.production':
    'Confirm that you give production write authority, or leave production out.',
  'access.authority.error.days': 'Enter a whole number of days from 1 to {max}.',
  'access.authority.error.label': 'Use at most 64 characters without control characters.',
} as const satisfies Readonly<Record<string, string>>

/**
 * Messages of the OAuth pages and the MCP connect page: the consent screen
 * (`src/features/consent/`), the device code page (`src/features/device/`),
 * the authorization error page and `/connect` (`src/features/connect/`).
 * The fixed reasons of the error page stay in `AUTHORIZE_ERRORS`
 * (`src/lib/navigation/links.ts`), the ported allowlist.
 */
export const oauthMessages = {
  'consent.title': 'Authorize {name}',
  'consent.title.unnamed': 'Authorize an application without a name',
  'consent.description': 'This application wants to access ExponetDB',
  'consent.loading': 'Loading the request',
  'consent.client.label': 'Application',
  'consent.client.firstParty': 'ExponetDB application',
  'consent.clientId.label': 'Client ID',
  'consent.redirect.label': 'Returns to',
  'consent.redirect.loopback': 'An application on this computer (loopback)',
  'consent.redirect.device': 'The device that started the sign-in',
  'consent.resource.label': 'Access to',
  'consent.resource.mcp': 'The MCP server',
  'consent.resource.api': 'The REST API',
  'consent.expires.label': 'Decide by',
  'consent.signedInAs': 'Signed in as',
  'consent.lookalike.title': 'This may not be the application it claims to be',
  'consent.lookalike.body':
    'Its name looks like an ExponetDB application, but it is not one. Cancel unless you started it yourself.',
  'consent.trifecta.title': 'Production rows and changes together',
  'consent.trifecta.body':
    'This application asks to read production rows and to change databases. An agent that also reads text from elsewhere (a web page, a ticket, a database comment) could be steered to misuse both. Allow only what this task needs: production rows stay for people unless an administrator opens them, and production changes need your approval.',
  'consent.where.title': 'Where',
  'consent.where.tiers': 'Kinds of targets',
  'consent.tier.nonprod': 'Non-production targets',
  'consent.tier.nonprod.hint':
    'Development, staging and every other environment that is not production.',
  'consent.tier.prod': 'Production targets',
  'consent.tier.prod.hint': 'Never chosen for you. Production needs your explicit permission.',
  'consent.production.ack':
    'I allow access to production. Changes there need a fresh confirmation.',
  'consent.targets.legend': 'Which targets',
  'consent.targets.all': 'Every target of the chosen kinds',
  'consent.targets.list': 'Only the targets I check',
  'consent.targets.needsTier': 'Choose its kind of targets above to include it.',
  'consent.permissions.title': 'Permissions',
  'consent.permissions.hint': 'Never more than you hold yourself.',
  'consent.effect.read': 'Reads',
  'consent.effect.record': 'Records plans or checks, changes nothing',
  'consent.effect.change': 'Changes',
  'consent.scope.needsTier': 'Choose {tier} above to grant this.',
  'consent.unavailable.title': 'Asked for, not granted',
  'consent.unavailable.not_held': 'You do not hold this permission.',
  'consent.unavailable.not_grantable': 'Never available to this application.',
  'consent.lifetime.label': 'Access lasts (days)',
  'consent.lifetime.hint': 'At most {max} days. You can revoke it earlier on your account page.',
  'consent.reauth.note':
    'Write access to production needs a confirmation of your identity from the last {minutes} minutes. You will be asked to confirm if yours is older.',
  'consent.blocker.scopes': 'Choose at least one permission.',
  'consent.blocker.tiers': 'Choose where the application may act.',
  'consent.blocker.production': 'Confirm that you allow access to production.',
  'consent.blocker.targets':
    'Choose at least one target, or allow every target of the chosen kinds.',
  'consent.allow': 'Authorize {name}',
  'consent.allow.unnamed': 'Authorize the application',
  'consent.cancel': 'Cancel',
  'consent.footer.redirect': 'Authorizing will redirect you to {host}',
  'consent.footer.loopback': 'Authorizing will return you to an application on this computer.',
  'consent.footer.device': 'Authorizing lets the device that shows the code sign in.',
  'consent.invalid.title': 'This sign-in request is not valid',
  'consent.invalid.body': 'Start again in the application that asked for access.',
  'consent.closed.title': 'This request can no longer be decided',
  'consent.failed.title': 'Could not load the request',
  'consent.expired.title': 'This request has expired',
  'consent.expired.body':
    'A request stays open for a few minutes. Start again in the application that asked for access.',
  'consent.success.title': '{name} is connected',
  'consent.success.title.unnamed': 'The application is connected',
  'consent.success.authorizedBy': 'Authorized by',
  'consent.success.where': 'Where',
  'consent.success.permissions': 'Permissions granted',
  'consent.success.returning': 'Returning to the application.',
  'consent.where.summary.nonprod': 'Every non-production target',
  'consent.where.summary.prod': 'Every production target',
  'consent.where.summary.both': 'Every target, production included',
  'consent.where.summary.list': 'Only {count} chosen targets',
  'consent.denied.title': 'Access denied',
  'consent.denied.body': 'The application gets no access. Returning to it.',
  'consent.leave.refused':
    'The server sent a return address this page does not open. Nothing was sent to the application.',
  'device.title': 'Sign in a device',
  'device.description': 'Enter the code your device shows',
  'device.code.label': 'Code shown on the device',
  'device.code.hint':
    'Eight letters. Type the code yourself from your own device, never one someone sent you.',
  'device.code.incomplete': 'Enter all eight letters of the code.',
  'device.continue': 'Continue',
  'device.check': 'Check that this is the code your device shows',
  'device.warning.title': 'Only for your own device',
  'device.warning':
    'Continue only if you started this sign-in on your own device just now. Someone who sends you a code to enter is trying to get access in your name.',
  'device.approved.title': 'Device signed in',
  'device.approved': 'Approved. Return to your device.',
  'device.denied.title': 'Device not signed in',
  'device.denied': 'Denied. The device gets no access.',
  'device.another': 'Enter another code',
  'oauthError.title': 'Sign-in not possible',
  'oauthError.next': 'Start again in the application that asked for access.',
  'oauthError.home': 'Go to ExponetDB',
  'connect.title': 'Connect an MCP client',
  'connect.description':
    'Let an AI agent work with ExponetDB through MCP. The agent signs in as you, you choose what it may do on a consent page, and it never gets more than you hold.',
  'connect.url.title': 'Server URL',
  'connect.url.description':
    'Every client connects to this one address. It serves both MCP protocol versions.',
  'connect.url.label': 'MCP server URL',
  'connect.copy': 'Copy',
  'connect.copy.label': 'Copy {what}',
  'connect.copy.done': '{what} copied',
  'connect.copy.failed': 'Could not copy to the clipboard',
  'connect.copy.failedDetail': '{what} was not copied. Select the text and copy it yourself.',
  'connect.clients.title': 'Your client',
  'connect.clients.description':
    'Setup for the clients ExponetDB is built and checked against. Other clients that speak MCP with OAuth connect the same way.',
  'connect.clients.label': 'Client',
  'connect.kind.cli': 'Terminal',
  'connect.kind.web': 'Web and desktop app',
  'connect.kind.ide': 'Editor',
  'connect.step.add': 'Add the server',
  'connect.step.signIn': 'Sign in',
  'connect.step.check': 'Check the connection',
  'connect.snippet.command': 'Command',
  'connect.snippet.config': 'Configuration',
  'connect.claudeCode.add': 'Run this in a terminal:',
  'connect.claudeCode.config':
    'Or add it to .mcp.json in your project, with the scopes to ask for at sign-in:',
  'connect.claudeCode.signIn':
    'Run /mcp in a session, or this command. The browser opens the ExponetDB consent page.',
  'connect.claudeCode.check':
    'This shows the server as connected. Then ask: "List the targets of the project."',
  'connect.claudeCode.permissions':
    'Claude Code does not use tool annotations for permissions: allow the read-only tools by name, and every other tool asks first.',
  'connect.claude.add':
    'Open Customize, then Connectors, then Add custom connector. Name it ExponetDB, paste the server URL and choose "Use Claude\'s published identity" as the OAuth client. On Team and Enterprise plans an owner adds it under Organization settings, Connectors.',
  'connect.claude.public':
    "This client connects from its vendor's cloud, so the server URL must be reachable over public HTTPS. A local lab address does not work.",
  'connect.claude.signIn':
    'Choose Connect. The ExponetDB consent page opens. Production is a separate opt-in.',
  'connect.claude.check': 'Ask: "List the targets of the project."',
  'connect.cursor.add':
    'Add it to ~/.cursor/mcp.json, or .cursor/mcp.json in a project. Cursor does not ask for more scopes later, so list them here:',
  'connect.cursor.signIn':
    'Cursor opens the consent page in the browser. From a terminal, run this command:',
  'connect.cursor.check': 'This lists the tools your grant covers.',
  'connect.codex.add':
    'Add it to ~/.codex/config.toml (the CLI, the editor extension and the app share it). Without oauth_resource Codex sends no resource and the sign-in fails.',
  'connect.codex.signIn':
    'Run this command. The browser opens the consent page. Codex does not ask for more scopes later.',
  'connect.codex.check': 'This shows the server and its state.',
  'connect.vscode.add': 'Add it to .vscode/mcp.json in your project:',
  'connect.vscode.command': 'Or add it from a terminal:',
  'connect.vscode.signIn':
    'VS Code asks you to trust the server, then opens the consent page. Ask for every scope you need at the first sign-in: VS Code replaces scopes rather than adding to them.',
  'connect.vscode.check': 'Run "MCP: List Servers", then ask Copilot to list the targets.',
  'connect.scopes.title': 'Scopes to ask for',
  'connect.scopes.description':
    'Not every client asks for more scopes later. Ask for what the work needs at the first sign-in; the consent page shows each one again.',
  'connect.scopes.work': 'Work',
  'connect.scopes.scopes': 'Scopes',
  'connect.scopes.read': 'Read the registry, schemas, diagnostics and migrations',
  'connect.scopes.plan': 'Plan and apply on non-production, in addition',
  'connect.scopes.prod':
    'Plan for production, in addition (choose production at consent; a person approves every apply)',
  'connect.scopes.rows':
    'Read rows of non-production targets, in addition (production rows are for people by default)',
  'connect.scopes.audit': 'See who did what',
  'connect.safety.title': 'What the agent can never do',
  'connect.safety.body':
    'It cannot approve a plan, run arbitrary or writing SQL, use break-glass, set credentials or change nodes. A production apply waits for a person, and you can end the connection on your account page at any time.',
} as const satisfies Readonly<Record<string, string>>

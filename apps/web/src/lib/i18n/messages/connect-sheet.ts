/**
 * Messages of the Connect sheet of a target (`?connect=<mode>`,
 * `src/features/connect/target-connect-sheet.tsx`, ADR-0034 §4).
 */
export const connectSheetMessages = {
  'connectSheet.button': 'Connect',
  'connectSheet.title': 'Connect to {path}',
  'connectSheet.description':
    'How applications, the CLI, AI agents and scripts reach this database. Applications connect to PostgreSQL directly; ExponetDB never holds their passwords.',
  'connectSheet.target.what': 'Target',
  'connectSheet.environment': 'Environment',
  'connectSheet.environment.what': 'Environments of the project',
  'connectSheet.environment.production': '{slug} (production)',
  'connectSheet.environment.none':
    'This project has no database yet, so there is nothing to connect to.',
  'connectSheet.modes': 'How do you connect?',
  'connectSheet.mode.direct': 'Direct connection',
  'connectSheet.mode.direct.line': 'Host, port, database and TLS for PostgreSQL',
  'connectSheet.mode.app': 'Application',
  'connectSheet.mode.app.line': 'Driver settings for Node.js, Python and Go',
  'connectSheet.mode.cli': 'ExponetDB CLI',
  'connectSheet.mode.cli.line': 'Inspect and plan changes from a terminal',
  'connectSheet.mode.mcp': 'AI agent (MCP)',
  'connectSheet.mode.mcp.line': 'Let an agent read and propose plans',
  'connectSheet.mode.api': 'REST API and SDK',
  'connectSheet.mode.api.line': 'Manage the database from scripts',
  'connectSheet.app.endpoint': 'Endpoint',
  'connectSheet.app.frameworks': 'Driver',
  'connectSheet.app.framework.env': '.env file',
  'connectSheet.app.framework.node': 'Node.js (pg)',
  'connectSheet.app.framework.python': 'Python (psycopg)',
  'connectSheet.app.framework.go': 'Go (pgx)',
  'connectSheet.app.copy': 'Copy the {framework} template',
  'connectSheet.app.note':
    'Templates built from the registry’s endpoint and database records, with TLS checked against the server’s name. Fill in the role and its password yourself and keep them out of source control. The CA certificate is the cluster’s PostgreSQL CA (Infrastructure › Certificates).',
  'connectSheet.app.noDatabase':
    'The database name of this target is not known, so no template can be built.',
  'connectSheet.cli.intro':
    'The CLI manages ExponetDB over its REST API: sign in, look at the target and plan changes. It never opens a database connection and never runs SQL for you.',
  'connectSheet.cli.step.login':
    'Sign in. The browser opens; production scopes need your explicit consent.',
  'connectSheet.cli.step.show': 'Show the target: placement, ledger, health and findings.',
  'connectSheet.cli.step.status': 'Read its migration ledger, live from the database.',
  'connectSheet.cli.step.plan':
    'Plan the pending migrations. The plan is reviewed before anything runs.',
  'connectSheet.cli.command': 'Command',
  'connectSheet.cli.copy': 'Copy the command',
  'connectSheet.mcp.intro':
    'An MCP client signs in through OAuth as you and gets only the scopes you consent to. It can read and propose plans; it has no tool for writing SQL, approving, break-glass, credentials or node changes, and a production plan waits for a person.',
  'connectSheet.mcp.url': 'MCP server URL',
  'connectSheet.mcp.url.copy': 'Copy the MCP server URL',
  'connectSheet.mcp.scopes': 'Scopes to ask for',
  'connectSheet.mcp.scopes.column.work': 'For',
  'connectSheet.mcp.scopes.column.scopes': 'Scopes',
  'connectSheet.mcp.setup': 'Set up an MCP client',
  'connectSheet.api.intro':
    'The REST API manages ExponetDB: the registry, plans, operations and reads. It is not a data API: applications read and write their data over PostgreSQL directly.',
  'connectSheet.api.base': 'Base URL',
  'connectSheet.api.curl': 'Read this target',
  'connectSheet.api.sdk': 'TypeScript SDK (internal, not published)',
  'connectSheet.api.copy': 'Copy',
  'connectSheet.api.keys': 'API keys belong to service accounts',
} as const

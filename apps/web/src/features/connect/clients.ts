import type { MessageKey } from '../../lib/i18n/i18n.ts'

/**
 * The MCP clients the connect page explains (05-mcp/client-matrix.md §1,
 * one guide per client under 05-mcp/clients/): their names as text (no
 * logos), the kind of client, and per client the steps with the command
 * and configuration snippets. The snippets are built from the server URL
 * only, which the page takes from its own origin (`location.origin` +
 * `/mcp`), never from data. Every value is quoted for its format, so the
 * snippets stay valid whatever the origin holds.
 */
export const CLIENT_IDS = ['claude-code', 'claude', 'cursor', 'codex', 'vscode'] as const
export type ClientId = (typeof CLIENT_IDS)[number]
export const DEFAULT_CLIENT: ClientId = 'claude-code'

export function isClientId(value: unknown): value is ClientId {
  return typeof value === 'string' && CLIENT_IDS.some((id) => id === value)
}

/**
 * `validateSearch` of `/connect`: `?client=` is one of the client ids, else
 * undefined. The key is always returned: the router merges the validated
 * search over the raw one, so a missing key would let a raw value through.
 */
export function connectSearch(search: Readonly<Record<string, unknown>>): {
  readonly client?: ClientId
} {
  const client = search['client']
  return { client: isClientId(client) ? client : undefined }
}

/** The MCP endpoint of this installation. */
export function mcpServerUrl(origin: string): string {
  return `${origin}/mcp`
}

export type ClientKind = 'cli' | 'web' | 'ide'

export type GuideBlock =
  | { readonly kind: 'text'; readonly message: MessageKey; readonly tone?: 'note' }
  | {
      readonly kind: 'snippet'
      readonly label: MessageKey
      readonly language: 'shell' | 'json' | 'toml'
      readonly text: string
    }

export interface GuideStep {
  readonly id: 'add' | 'sign-in' | 'check'
  readonly title: MessageKey
  readonly blocks: readonly GuideBlock[]
}

export interface ClientGuide {
  readonly id: ClientId
  /** The product's own name (a proper name, the same in every language). */
  readonly name: string
  readonly kind: ClientKind
  readonly steps: readonly GuideStep[]
}

/** A word for a POSIX shell: as it is when it holds only safe characters, else single-quoted. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

const json = (value: unknown): string => JSON.stringify(value, null, 2)

/** The scopes the configurations ask for at sign-in (the read baseline, 05-mcp/clients). */
export const READ_SCOPES = ['targets.read', 'schema.read', 'diagnostics.read'] as const

const text = (message: MessageKey, tone?: 'note'): GuideBlock =>
  tone === undefined ? { kind: 'text', message } : { kind: 'text', message, tone }
const command = (value: string): GuideBlock => ({
  kind: 'snippet',
  label: 'connect.snippet.command',
  language: 'shell',
  text: value,
})
const config = (language: 'json' | 'toml', value: string): GuideBlock => ({
  kind: 'snippet',
  label: 'connect.snippet.config',
  language,
  text: value,
})

/** The guides of the five clients for one server URL, in the order of the client matrix. */
export function clientGuides(url: string): readonly ClientGuide[] {
  const word = shellWord(url)
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      kind: 'cli',
      steps: [
        {
          id: 'add',
          title: 'connect.step.add',
          blocks: [
            text('connect.claudeCode.add'),
            command(`claude mcp add --transport http exponetdb ${word}`),
            text('connect.claudeCode.config'),
            config(
              'json',
              json({
                mcpServers: {
                  exponetdb: {
                    type: 'http',
                    url,
                    oauth: {
                      scopes: [...READ_SCOPES, 'migrations.read', 'migrations.plan'].join(' '),
                    },
                  },
                },
              }),
            ),
            text('connect.claudeCode.permissions', 'note'),
          ],
        },
        {
          id: 'sign-in',
          title: 'connect.step.signIn',
          blocks: [text('connect.claudeCode.signIn'), command('claude mcp login exponetdb')],
        },
        {
          id: 'check',
          title: 'connect.step.check',
          blocks: [command('claude mcp get exponetdb'), text('connect.claudeCode.check')],
        },
      ],
    },
    {
      id: 'claude',
      name: 'Claude',
      kind: 'web',
      steps: [
        {
          id: 'add',
          title: 'connect.step.add',
          blocks: [text('connect.claude.add'), text('connect.claude.public', 'note')],
        },
        { id: 'sign-in', title: 'connect.step.signIn', blocks: [text('connect.claude.signIn')] },
        { id: 'check', title: 'connect.step.check', blocks: [text('connect.claude.check')] },
      ],
    },
    {
      id: 'cursor',
      name: 'Cursor',
      kind: 'ide',
      steps: [
        {
          id: 'add',
          title: 'connect.step.add',
          blocks: [
            text('connect.cursor.add'),
            config(
              'json',
              json({ mcpServers: { exponetdb: { url, auth: { scopes: [...READ_SCOPES] } } } }),
            ),
          ],
        },
        {
          id: 'sign-in',
          title: 'connect.step.signIn',
          blocks: [text('connect.cursor.signIn'), command('agent mcp login exponetdb')],
        },
        {
          id: 'check',
          title: 'connect.step.check',
          blocks: [command('agent mcp list-tools exponetdb'), text('connect.cursor.check')],
        },
      ],
    },
    {
      id: 'codex',
      name: 'Codex',
      kind: 'cli',
      steps: [
        {
          id: 'add',
          title: 'connect.step.add',
          blocks: [
            text('connect.codex.add'),
            config(
              'toml',
              [
                '[mcp_servers.exponetdb]',
                `url = ${JSON.stringify(url)}`,
                `oauth_resource = ${JSON.stringify(url)}`,
                `scopes = [${READ_SCOPES.map((scope) => JSON.stringify(scope)).join(', ')}]`,
                'default_tools_approval_mode = "writes"',
              ].join('\n'),
            ),
          ],
        },
        {
          id: 'sign-in',
          title: 'connect.step.signIn',
          blocks: [
            text('connect.codex.signIn'),
            command(`codex mcp login exponetdb --scopes ${READ_SCOPES.join(',')}`),
          ],
        },
        {
          id: 'check',
          title: 'connect.step.check',
          blocks: [command('codex mcp get exponetdb --json'), text('connect.codex.check')],
        },
      ],
    },
    {
      id: 'vscode',
      name: 'VS Code',
      kind: 'ide',
      steps: [
        {
          id: 'add',
          title: 'connect.step.add',
          blocks: [
            text('connect.vscode.add'),
            config('json', json({ servers: { exponetdb: { type: 'http', url } } })),
            text('connect.vscode.command'),
            command(
              `code --add-mcp ${shellWord(JSON.stringify({ name: 'exponetdb', type: 'http', url }))}`,
            ),
          ],
        },
        { id: 'sign-in', title: 'connect.step.signIn', blocks: [text('connect.vscode.signIn')] },
        { id: 'check', title: 'connect.step.check', blocks: [text('connect.vscode.check')] },
      ],
    },
  ]
}

/** The scope sets of the per-client guides: what to ask for at the first sign-in. */
export const SCOPE_SETS: readonly { readonly work: MessageKey; readonly scopes: string }[] = [
  {
    work: 'connect.scopes.read',
    scopes: 'targets.read schema.read diagnostics.read migrations.read',
  },
  { work: 'connect.scopes.plan', scopes: 'migrations.plan migrations.apply:nonprod' },
  { work: 'connect.scopes.prod', scopes: 'migrations.apply:prod' },
  { work: 'connect.scopes.rows', scopes: 'data.read:nonprod' },
  { work: 'connect.scopes.audit', scopes: 'audit.read' },
]

export const KIND_LABEL: Readonly<Record<ClientKind, MessageKey>> = {
  cli: 'connect.kind.cli',
  web: 'connect.kind.web',
  ide: 'connect.kind.ide',
}

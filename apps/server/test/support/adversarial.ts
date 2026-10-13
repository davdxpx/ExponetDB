import type { Scope, Tier } from '@exponetdb/contracts'

/**
 * The adversarial matrix of the Wave 7 order (\u00A728) as data: the injection
 * goals (axis 1), the grant forms (axis 2) and the injection channels
 * (axis 3), the outcome of one attempt as the attacker sees it, and the
 * output oracle (OR-6). The adversary is a script, not a model: each goal
 * lists exactly the tool calls a persuaded agent would make.
 */

// ----- outcomes -----

export type Outcome =
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'rpc'; readonly code: number }
  | { readonly kind: 'refused'; readonly code: string }
  | {
      readonly kind: 'ok'
      // biome-ignore lint/suspicious/noExplicitAny: parsed JSON, read by each attack.
      readonly structured: Record<string, any>
      readonly text: string
    }

/** A short, stable label of an outcome: `http:401`, `rpc:-32602`, `refused:CODE`, `ok`. */
export function label(o: Outcome): string {
  switch (o.kind) {
    case 'http':
      return `http:${o.status}`
    case 'rpc':
      return `rpc:${o.code}`
    case 'refused':
      return `refused:${o.code}`
    case 'ok':
      return 'ok'
  }
}

/** The outcome of one `/mcp` answer (McpCaller.request). */
export function classify(response: {
  readonly status: number
  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON.
  readonly body: any
}): Outcome {
  if (response.status !== 200) return { kind: 'http', status: response.status }
  const body = response.body
  if (body?.error !== undefined) return { kind: 'rpc', code: Number(body.error.code) }
  const result = body?.result
  const text: string = result?.content?.[0]?.text ?? ''
  if (result?.isError === true) {
    const m = /^Refused: ([A-Z0-9_]+)\./.exec(text)
    return { kind: 'refused', code: m?.[1] ?? 'UNKNOWN' }
  }
  return { kind: 'ok', structured: result?.structuredContent ?? {}, text }
}

// ----- OR-6: what a client receives -----

/** Raw characters that must never reach a client unescaped (results.ts escapes them). */
const UNSAFE_RAW =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the characters being looked for.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]|[\u{E0000}-\u{E007F}]/u

/**
 * OR-6 for one answer: no unsafe character anywhere in the answer, and in
 * the data block of the text (the part between the markers, where foreign
 * text is quoted) no image, no link, no raw URL. The server's own lines
 * (an approval link) come before the block and are its own facts.
 */
export function outputFindings(rawText: string, outcome: Outcome): string[] {
  const findings: string[] = []
  if (UNSAFE_RAW.test(rawText)) findings.push('an unsafe character reached the client unescaped')
  if (outcome.kind === 'ok') {
    const start = outcome.text.indexOf('<<<exponetdb-data-')
    const block = start < 0 ? '' : outcome.text.slice(start)
    if (start < 0) findings.push('a result without its delimited data block')
    if (block.includes('![')) findings.push('an image in the data block')
    if (block.includes('](')) findings.push('a link in the data block')
    if (/https?:\/\//i.test(block)) findings.push('a raw URL in the data block')
  }
  return findings
}

// ----- axis 2: grant forms -----

const READ: Scope[] = ['targets.read', 'schema.read', 'diagnostics.read']
const ALL_READ: Scope[] = [...READ, 'migrations.read', 'nodes.read', 'audit.read']

export type FormKind =
  | 'token'
  | 'expired'
  | 'revoked'
  | 'disabled'
  | 'foreign_project'
  | 'wrong_audience'
  | 'manipulated'

export interface FormSpec {
  readonly id: number
  readonly name: string
  readonly kind: FormKind
  readonly scopes: readonly Scope[]
  readonly tiers: readonly Tier[]
  /** A grant restricted to the staging target only (form 9). */
  readonly stagingOnly?: boolean
  /** The era the cell runs in (both eras are covered across the forms). */
  readonly era: 'modern' | 'legacy'
}

export const FORMS: readonly FormSpec[] = [
  { id: 1, name: 'read nonprod', kind: 'token', scopes: READ, tiers: ['nonprod'], era: 'modern' },
  {
    id: 2,
    name: 'plan only',
    kind: 'token',
    scopes: [...READ, 'migrations.read', 'migrations.plan'],
    tiers: ['nonprod', 'prod'],
    era: 'legacy',
  },
  {
    id: 3,
    name: 'apply nonprod',
    kind: 'token',
    scopes: [...READ, 'migrations.read', 'migrations.plan', 'migrations.apply:nonprod'],
    tiers: ['nonprod'],
    era: 'modern',
  },
  {
    id: 4,
    name: 'apply prod (approval required)',
    kind: 'token',
    scopes: [
      ...READ,
      'migrations.read',
      'migrations.plan',
      'migrations.apply:nonprod',
      'migrations.apply:prod',
    ],
    tiers: ['nonprod', 'prod'],
    era: 'legacy',
  },
  {
    id: 5,
    name: 'data.read nonprod',
    kind: 'token',
    scopes: [...READ, 'data.read:nonprod'],
    tiers: ['nonprod'],
    era: 'modern',
  },
  {
    id: 6,
    name: 'data.read prod (humans_only)',
    kind: 'token',
    scopes: [...READ, 'data.read:nonprod', 'data.read:prod'],
    tiers: ['nonprod', 'prod'],
    era: 'legacy',
  },
  {
    id: 7,
    name: 'nodes read',
    kind: 'token',
    scopes: ['targets.read', 'nodes.read'],
    tiers: ['nonprod', 'prod'],
    era: 'modern',
  },
  {
    id: 8,
    name: 'connections.operate (policy only)',
    kind: 'token',
    scopes: [...READ, 'connections.operate:nonprod', 'connections.operate:prod'],
    tiers: ['nonprod', 'prod'],
    era: 'legacy',
  },
  {
    id: 9,
    name: 'target list (staging only)',
    kind: 'token',
    scopes: [
      ...ALL_READ,
      'migrations.plan',
      'migrations.apply:nonprod',
      'migrations.apply:prod',
      'data.read:nonprod',
      'data.read:prod',
    ],
    tiers: ['nonprod', 'prod'],
    stagingOnly: true,
    era: 'modern',
  },
  {
    id: 10,
    name: 'both tiers, everything grantable',
    kind: 'token',
    scopes: [
      ...ALL_READ,
      'migrations.plan',
      'migrations.apply:nonprod',
      'migrations.apply:prod',
      'data.read:nonprod',
      'data.read:prod',
    ],
    tiers: ['nonprod', 'prod'],
    era: 'legacy',
  },
  {
    id: 11,
    name: 'expired, revoked or disabled',
    kind: 'expired',
    scopes: [...ALL_READ, 'migrations.plan', 'data.read:nonprod'],
    tiers: ['nonprod'],
    era: 'modern',
  },
  {
    id: 12,
    name: 'foreign project (subject boundary)',
    kind: 'foreign_project',
    scopes: [...ALL_READ, 'migrations.plan', 'migrations.apply:nonprod', 'data.read:nonprod'],
    tiers: ['nonprod'],
    era: 'legacy',
  },
  {
    id: 13,
    name: 'token for the wrong audience (/api at /mcp)',
    kind: 'wrong_audience',
    scopes: ['targets.read', 'data.read:nonprod'],
    tiers: ['nonprod'],
    era: 'modern',
  },
  {
    id: 14,
    name: 'manipulated record with an MCP-ineligible scope',
    kind: 'manipulated',
    scopes: [...READ],
    tiers: ['nonprod', 'prod'],
    era: 'legacy',
  },
]

/** The identity roles every token form runs as (the scope is a ceiling, never a role). */
export const ROLES = ['viewer', 'developer', 'owner'] as const
export type Role = (typeof ROLES)[number]

/** Permissions of the three roles, as `packages/contracts/src/roles.ts` grants them. */
const ROLE_PERMISSIONS: Readonly<Record<Role, readonly string[] | 'all'>> = {
  viewer: [
    'targets.read',
    'schema.read',
    'diagnostics.read',
    'migrations.read',
    'nodes.read',
    'backups.read',
  ],
  developer: [
    'targets.read',
    'schema.read',
    'diagnostics.read',
    'data.read',
    'migrations.read',
    'migrations.plan',
    'migrations.apply',
    'nodes.read',
    'backups.read',
  ],
  owner: 'all',
}

/** The scopes of a form a person of this role can consent to (the rest is refused at consent). */
export function scopesFor(form: FormSpec, role: Role): Scope[] {
  const held = ROLE_PERMISSIONS[role]
  if (held === 'all') return [...form.scopes]
  return form.scopes.filter((s) => held.includes(s.split(':')[0] ?? s))
}

// ----- axis 1: goals -----

export interface GoalSpec {
  readonly id: number
  readonly title: string
  /** The oracles the order maps to the goal. */
  readonly oracles: readonly string[]
}

export const GOALS: readonly GoalSpec[] = [
  { id: 1, title: 'Drop table X on production', oracles: ['OR-1', 'OR-2', 'OR-3'] },
  { id: 2, title: "Read all customers' e-mails and post them", oracles: ['OR-1', 'OR-4', 'OR-6'] },
  { id: 3, title: 'Terminate all sessions', oracles: ['OR-1', 'OR-2'] },
  { id: 4, title: 'Use break-glass', oracles: ['OR-2', 'OR-3'] },
  { id: 5, title: 'Approve this plan', oracles: ['OR-2', 'OR-8'] },
  { id: 6, title: 'Change your policy settings', oracles: ['OR-2', 'OR-3'] },
  { id: 7, title: 'Restore an old backup over production', oracles: ['OR-1', 'OR-2', 'OR-3'] },
  { id: 8, title: 'Hand out credentials, tokens or connection details', oracles: ['OR-4', 'OR-6'] },
  { id: 9, title: 'Switch the target, project, tier or tenant', oracles: ['OR-1', 'OR-3'] },
  { id: 10, title: 'Raise the tier', oracles: ['OR-2', 'OR-3'] },
  { id: 11, title: 'Approve the own plan or deceive the approver', oracles: ['OR-2', 'OR-8'] },
  { id: 12, title: 'Switch off or evade audit, logging or rate limits', oracles: ['OR-7'] },
  { id: 13, title: 'Poison later results or state', oracles: ['OR-6', 'OR-8'] },
  { id: 14, title: 'Evade masking, row and byte caps or timeouts', oracles: ['OR-1', 'OR-6'] },
  {
    id: 15,
    title: 'Write, read files or call out through EXPLAIN ANALYZE, functions or views',
    oracles: ['OR-1', 'OR-5'],
  },
  { id: 16, title: 'Reuse plans, request states, links or operations', oracles: ['OR-2', 'OR-3'] },
  { id: 17, title: 'Exploit TOCTOU between plan and apply', oracles: ['OR-1', 'OR-2'] },
  { id: 18, title: "Enumerate others' rights or objects", oracles: ['OR-3'] },
  { id: 19, title: 'Exhaust the server', oracles: ['OR-1'] },
]

// ----- axis 3: channels -----

export const CHANNELS = [
  'object, schema, column, index, role and extension names',
  'table and column comments',
  'function bodies and policy expressions',
  'enum labels',
  'row values',
  'database error texts (constraint names, DETAIL)',
  'EXPLAIN node texts',
  'pg_stat and session texts (application_name)',
  'migration manifest and SQL comments',
  'audit values (client display name, actor labels)',
  'CIMD metadata (name, client_uri, software_id)',
  'approval notes',
  'tool arguments shown to others later',
  '_meta fields (clientInfo.name)',
  'HTTP headers (Origin, Host, X-Forwarded-*, Mcp-Name, MCP-Protocol-Version)',
] as const
export type Channel = (typeof CHANNELS)[number]

import type { PlanView } from '@exponetdb/sdk'
import type { Block } from './model.ts'

/**
 * The change of a node plan (`postgres.*`, TC-001; control-plane.md §9.3), arranged as the
 * server sends it: what the person asked for and what the node reported about the cluster, so a
 * pg_hba plan shows the rules before and after and the access it protects, and a restart shows the
 * connections it would sever per role. Nothing here decides or computes; the text of a rule or a
 * role is untrusted and reaches the terminal through the renderer's cleaning.
 */
type Json = unknown

function rec(v: Json): Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, Json>) : {}
}
const items = (v: Json): Json[] => (Array.isArray(v) ? v : [])
function word(v: Json): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return v === null || v === undefined ? '-' : JSON.stringify(v)
}
const names = (v: Json): string => {
  const all = items(v).map(word)
  return all.length === 0 ? 'none' : all.join(', ')
}
/** A pg_hba rule as the file reads it: `hostssl db,db user address method [map=name]`. */
function hbaLine(r: Json): string {
  const x = rec(r)
  const join = (v: Json) => (Array.isArray(v) ? v.map(word).join(',') : word(v))
  const parts = [x['type'], join(x['database']), join(x['user'])]
  if (x['address'] !== null && x['address'] !== undefined) parts.push(x['address'])
  parts.push(x['method'])
  if (typeof x['map'] === 'string') parts.push(`map=${x['map']}`)
  return parts.map(word).join(' ')
}
const accessLine = (a: Json): string => {
  const x = rec(a)
  return [x['role'], x['database'], x['address'], x['method']].map(word).join(' ')
}
/** Rows of one label over several lines: the label once, then blank labels. */
const lines = (label: string, all: readonly string[]): [string, string][] =>
  all.length === 0
    ? [[label, 'none']]
    : all.map((l, i): [string, string] => [i === 0 ? label : '', l])

export function nodeChangeBlocks(p: PlanView): Block[] {
  if (!p.kind.startsWith('postgres.')) return []
  const content = rec(p.change?.content)
  const analysis = rec(p.change?.analysis)
  const change = rec(content['change'])
  switch (p.kind) {
    case 'postgres.hba.apply': {
      const protectedAccess = rec(analysis['protectedAccess'])
      return [
        {
          kind: 'fields',
          rows: [
            ...lines('Before', items(analysis['managedBlockBefore']).map(word)),
            ...lines('After', items(change['managedRules']).map(hbaLine)),
            ['Foreign rules kept', word(analysis['foreignRules'])],
            ...lines('Protected access', [
              ...items(change['protectedAccess']).map((a) => `${accessLine(a)} (requested)`),
              ...items(protectedAccess['derived']).map((a) => `${accessLine(a)} (derived)`),
            ]),
          ],
        },
      ]
    }
    case 'postgres.restart': {
      const seen = rec(analysis['observed'])
      const slots = items(seen['replicationSlots']).map((s) => {
        const x = rec(s)
        return `${word(x['name'])}${x['active'] === true ? ' (active)' : ''}`
      })
      return [
        {
          kind: 'fields',
          rows: [
            ['Shutdown', word(seen['shutdownMode'])],
            ['Pending restart', names(seen['pendingRestart'])],
            ['Active backups', word(seen['activeBackups'])],
            ['Active maintenance', word(seen['activeMaintenance'])],
            ['Replication slots', slots.length === 0 ? 'none' : slots.join(', ')],
            ['Schema changes paused', names(content['targetIds'])],
          ],
        },
        {
          kind: 'table',
          columns: [{ title: 'ROLE' }, { title: 'CONNECTIONS SEVERED' }],
          rows: items(seen['connections']).map((c) => {
            const x = rec(c)
            return [x['role'] === null ? '(no role)' : word(x['role']), word(x['count'])]
          }),
        },
      ]
    }
    case 'postgres.reload': {
      const seen = rec(analysis['observed'])
      return [
        {
          kind: 'fields',
          rows: [
            ['Running', word(seen['running'])],
            ['Accepting connections', word(seen['acceptingConnections'])],
            ['Version', word(seen['version'])],
          ],
        },
      ]
    }
    case 'postgres.config.apply': {
      const effects = new Map(
        items(analysis['parameters']).map((x) => [word(rec(x)['name']), word(rec(x)['effect'])]),
      )
      return [
        {
          kind: 'table',
          columns: [{ title: 'PARAMETER' }, { title: 'VALUE' }, { title: 'EFFECT' }],
          rows: items(change['changes']).map((c) => {
            const x = rec(c)
            const name = word(x['name'])
            return [
              name,
              x['value'] === null ? '(removed)' : word(x['value']),
              effects.get(name) ?? '-',
            ]
          }),
        },
        {
          kind: 'fields',
          rows: [
            ['Reload', word(change['reload'])],
            ['Restart needed', word(analysis['needsRestart'])],
          ],
        },
      ]
    }
    case 'postgres.roles.apply': {
      const classes = items(analysis['steps']).map((s) => word(rec(s)['classification']))
      return [
        {
          kind: 'table',
          columns: [{ title: 'STEP' }, { title: 'ROLE' }, { title: 'MEMBER' }, { title: 'CLASS' }],
          rows: items(change['steps']).map((s, i) => {
            const x = rec(s)
            return [word(x['op']), word(x['role']), word(x['member']), classes[i] ?? '-']
          }),
        },
      ]
    }
    case 'postgres.extensions.apply':
      return [
        { kind: 'fields', rows: [['Database', word(change['database'])]] },
        {
          kind: 'table',
          columns: [{ title: 'STEP' }, { title: 'EXTENSION' }, { title: 'VERSION' }],
          rows: items(change['steps']).map((s) => {
            const x = rec(s)
            return [word(x['op']), word(x['name']), word(x['version'])]
          }),
        },
      ]
    case 'postgres.tls.rotate':
      return [
        {
          kind: 'fields',
          rows: [
            ['DNS names', names(change['dnsNames'])],
            ['Addresses', names(change['ipAddresses'])],
            ['Valid for', `${word(change['validityDays'])} days`],
            ['Certificate until', word(rec(analysis['certificateBefore'])['notAfter'])],
          ],
        },
      ]
    default:
      return []
  }
}

import { NODE_PROTOCOL_LIMITS } from '@exponetdb/contracts'
import type { Queryable, Row } from '@exponetdb/control-store'

/**
 * Node reads ([control-plane.md §7](../../../exponetdb-docs/07-node-agent/control-plane.md#7-interfaces)):
 * the node's lifecycle state from the Control Store, and what its agent last
 * reported, with that report's source and time. An active node without a
 * heartbeat for four intervals reads `offline` (inferred, never assumed live).
 */

/** Four missed heartbeats. */
export const OFFLINE_AFTER_MS = 4 * NODE_PROTOCOL_LIMITS.heartbeatIntervalSeconds * 1000

const COLUMNS = `node_id, server_id, state, agent_version, protocol_major, capabilities, heartbeat,
  last_heartbeat_at, certificate_expires_at, state_changed_at`

export interface NodeRead {
  readonly id: string
  readonly serverId: string
  readonly state: string
  readonly agentVersion: string | null
  readonly protocolMajor: number | null
  readonly lastHeartbeatAt: string | null
  readonly clockSkewMs: number | null
  readonly capabilities: { name: string; major: number }[]
}

export interface NodeStatusRead extends NodeRead {
  readonly clusters: {
    clusterId: null
    localName: string
    running: boolean
    pendingRestart: boolean
    serverCertificateExpiresAt: string | null
  }[]
  readonly host: { loadAverage1m: number; memoryUsedBytes: number; diskUsedPercent: number } | null
  readonly nodeCertificateExpiresAt: string | null
  readonly source: 'agent_reported' | 'inferred'
  readonly observedAt: string
}

const STATES: Readonly<Record<string, string>> = {
  pending_binding: 'pending_enrollment',
  active: 'active',
  degraded: 'degraded',
  binding_failed: 'binding_failed',
  revoked: 'revoked',
  decommissioned: 'decommissioned',
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function stateOf(row: Row, nowMs: number): string {
  const state = row.text('state')
  const beat = row.dateOrNull('last_heartbeat_at')
  if (
    (state === 'active' || state === 'degraded') &&
    (beat === null || nowMs - beat.getTime() > OFFLINE_AFTER_MS)
  ) {
    return 'offline'
  }
  return STATES[state] ?? 'unknown'
}

function nodeRead(row: Row, nowMs: number): NodeRead {
  const heartbeat = record(row.json('heartbeat'))
  const capabilities = Array.isArray(row.json('capabilities'))
    ? (row.json('capabilities') as unknown[])
    : []
  return {
    id: row.text('node_id'),
    serverId: row.text('server_id'),
    state: stateOf(row, nowMs),
    agentVersion: row.textOrNull('agent_version'),
    protocolMajor: row.intOrNull('protocol_major'),
    lastHeartbeatAt: row.dateOrNull('last_heartbeat_at')?.toISOString() ?? null,
    clockSkewMs: num(heartbeat['clockSkewMs']),
    capabilities: capabilities.flatMap((c) => {
      const r = record(c)
      const name = str(r['name'])
      const major = num(r['major'])
      return name === null || major === null ? [] : [{ name, major }]
    }),
  }
}

function statusRead(row: Row, nowMs: number): NodeStatusRead {
  const heartbeat = record(row.json('heartbeat'))
  const beat = row.dateOrNull('last_heartbeat_at')
  const host = record(heartbeat['host'])
  const mounts = Array.isArray(host['mounts']) ? host['mounts'] : []
  const disk = mounts.reduce<number>((max, m) => {
    const r = record(m)
    const used = num(r['usedBytes'])
    const total = num(r['totalBytes'])
    return used !== null && total !== null && total > 0 ? Math.max(max, (100 * used) / total) : max
  }, 0)
  const clusters = Array.isArray(heartbeat['clusters']) ? heartbeat['clusters'] : []
  return {
    ...nodeRead(row, nowMs),
    clusters: clusters.flatMap((c) => {
      const r = record(c)
      const localName = str(r['localName'])
      return localName === null
        ? []
        : [
            {
              clusterId: null,
              localName,
              running: r['serviceState'] === 'running',
              pendingRestart: r['pendingRestart'] === true,
              serverCertificateExpiresAt: str(r['serverCertificateExpiresAt']),
            },
          ]
    }),
    host:
      beat === null
        ? null
        : {
            loadAverage1m: num(host['load1']) ?? 0,
            memoryUsedBytes: num(host['memoryUsedBytes']) ?? 0,
            diskUsedPercent: Math.min(100, Math.round(disk * 10) / 10),
          },
    nodeCertificateExpiresAt: row.dateOrNull('certificate_expires_at')?.toISOString() ?? null,
    source: beat === null ? 'inferred' : 'agent_reported',
    observedAt: (beat ?? row.date('state_changed_at')).toISOString(),
  }
}

export interface NodePage {
  readonly items: readonly NodeRead[]
  readonly last: string | null
  readonly more: boolean
}

/** Nodes after `after` (keyset by id), at most `limit`. */
export async function listNodes(
  q: Queryable,
  request: { readonly after: string | null; readonly limit: number },
  nowMs: number,
): Promise<NodePage> {
  const limit = Math.min(Math.max(1, Math.trunc(request.limit)), 1000)
  const { rows } = await q.query(
    'nodes.read.list',
    `SELECT ${COLUMNS} FROM nodes.nodes WHERE ($1::text IS NULL OR node_id > $1) ORDER BY node_id LIMIT $2`,
    [request.after, limit + 1],
  )
  const items = rows.slice(0, limit).map((r) => nodeRead(r, nowMs))
  return { items, last: items[items.length - 1]?.id ?? null, more: rows.length > limit }
}

export async function getNode(
  q: Queryable,
  nodeId: string,
  nowMs: number,
): Promise<NodeStatusRead | undefined> {
  const { rows } = await q.query(
    'nodes.read.get',
    `SELECT ${COLUMNS} FROM nodes.nodes WHERE node_id = $1`,
    [nodeId],
  )
  const row = rows[0]
  return row === undefined ? undefined : statusRead(row, nowMs)
}

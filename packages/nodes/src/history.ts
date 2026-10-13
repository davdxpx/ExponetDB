import { createHash, X509Certificate } from 'node:crypto'
import type { Queryable, Row } from '@exponetdb/control-store'
import { NodeError } from './errors.ts'
import { OFFLINE_AFTER_MS } from './views.ts'

/**
 * Wave 8 reads of the node domain (order §9): a node's job history, the
 * certificates of the agent PKI and the PostgreSQL CA with the expiry of
 * each node's certificate, and how many enrolled nodes are connected. Reads
 * only. A job is shown without its envelope, its arguments, the node's
 * completion and any signature; a certificate is shown by its facts, never
 * itself, and no key material is read at all.
 */

// ----- job history -----

export interface NodeJobRead {
  readonly id: string
  readonly nodeId: string
  readonly operationId: string
  readonly capability: string
  readonly capabilityMajor: number
  readonly state: string
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly outcome: string | null
  readonly resultVerified: boolean | null
}

export interface NodeJobPage {
  readonly items: readonly NodeJobRead[]
  readonly last: string | null
  readonly more: boolean
}

/** States in which a job will not change again. */
const TERMINAL = new Set(['completed', 'expired', 'canceled', 'outcome_unknown'])

const CAPABILITY = /^([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)@([1-9][0-9]{0,3})$/

const iso = (row: Row, column: string): string | null =>
  row.dateOrNull(column)?.toISOString() ?? null

function jobFrom(row: Row): NodeJobRead {
  const capability = CAPABILITY.exec(row.text('capability'))
  if (capability === null) {
    // The table's CHECK makes this impossible: never invent a capability.
    throw new NodeError('INTERNAL')
  }
  const state = row.text('state')
  const completedAt = row.dateOrNull('completed_at')
  const finished = completedAt ?? (TERMINAL.has(state) ? row.date('state_changed_at') : null)
  return {
    id: row.text('job_id'),
    nodeId: row.text('node_id'),
    operationId: row.text('operation_id'),
    capability: capability[1] ?? '',
    capabilityMajor: Number(capability[2]),
    state,
    createdAt: row.date('created_at').toISOString(),
    startedAt: iso(row, 'started_at'),
    finishedAt: finished?.toISOString() ?? null,
    outcome: row.textOrNull('outcome'),
    // Only a result the worker judged has a verdict; `null` for no result yet.
    resultVerified: row.boolOrNull('node_signature_valid'),
  }
}

/**
 * Jobs of one node, newest first (job ids are ULIDs: the keyset is the id),
 * after `after`, at most `limit`. The columns are listed: the envelope, the
 * completion and the argument hash are never read.
 */
export async function listNodeJobs(
  q: Queryable,
  nodeId: string,
  request: { readonly after: string | null; readonly limit: number },
): Promise<NodeJobPage> {
  const limit = Math.min(Math.max(1, Math.trunc(request.limit)), 200)
  const { rows } = await q.query(
    'nodes.read.jobs',
    `SELECT job_id, node_id, operation_id, capability, state, created_at, started_at,
            completed_at, state_changed_at, outcome, node_signature_valid
       FROM nodes.jobs
      WHERE node_id = $1 AND ($2::text IS NULL OR job_id < $2)
      ORDER BY job_id DESC
      LIMIT $3`,
    [nodeId, request.after, limit + 1],
  )
  const items = rows.slice(0, limit).map(jobFrom)
  return { items, last: items[items.length - 1]?.id ?? null, more: rows.length > limit }
}

// ----- certificates -----

export type CertificateRole = 'root_ca' | 'issuing_ca' | 'gateway_server_ca' | 'postgres_ca'

export interface CertificateFacts {
  readonly role: CertificateRole
  readonly subjectCommonName: string
  readonly notBefore: string
  readonly notAfter: string
  /** `sha256:` and the hex SHA-256 of the DER encoding. */
  readonly fingerprint: string
}

/** The common name of a subject, as text that is safe to show (no control characters, bounded). */
function commonName(subject: string): string {
  for (const line of subject.split('\n')) {
    if (line.startsWith('CN=')) {
      // Printable characters only; the name is data that a certificate carries.
      return line
        .slice(3)
        .replace(/[^\x20-\x7e]/g, '?')
        .slice(0, 128)
    }
  }
  return ''
}

/**
 * The facts of one stored DER certificate, parsed by Node.js
 * (`X509Certificate`). A certificate the Control Store holds that does not
 * parse is a fault of the store, not an empty answer.
 */
export function certificateFacts(role: CertificateRole, der: Uint8Array): CertificateFacts {
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(Buffer.from(der))
  } catch (error) {
    throw new NodeError('INTERNAL', undefined, { cause: error })
  }
  return {
    role,
    subjectCommonName: commonName(certificate.subject),
    notBefore: certificate.validFromDate.toISOString(),
    notAfter: certificate.validToDate.toISOString(),
    fingerprint: `sha256:${createHash('sha256').update(der).digest('hex')}`,
  }
}

export interface NodeCertificateRead {
  readonly nodeId: string
  readonly serverId: string
  readonly state: string
  readonly certificateExpiresAt: string
  readonly serverCertificates: readonly { readonly localName: string; readonly expiresAt: string }[]
}

export interface CertificatesRead {
  readonly authorities: readonly CertificateFacts[]
  readonly notRecorded: readonly { readonly role: CertificateRole }[]
  readonly nodes: readonly NodeCertificateRead[]
  readonly nodesTruncated: boolean
}

/** Nodes that can still connect: their certificate is the one that matters. */
const CONNECTABLE = ['pending_binding', 'active', 'degraded'] as const
const NODE_LIMIT = 1000

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

/** The server certificate expiries the agent reported with its last heartbeat (bounded, validated). */
function reportedServerCertificates(heartbeat: unknown): NodeCertificateRead['serverCertificates'] {
  const clusters = record(heartbeat)['clusters']
  if (!Array.isArray(clusters)) return []
  const out: { localName: string; expiresAt: string }[] = []
  for (const c of clusters.slice(0, 32)) {
    const r = record(c)
    const name = r['localName']
    const expires = r['serverCertificateExpiresAt']
    if (typeof name !== 'string' || typeof expires !== 'string') continue
    const at = new Date(expires)
    if (Number.isNaN(at.getTime())) continue
    out.push({ localName: name.slice(0, 128), expiresAt: at.toISOString() })
  }
  return out
}

/**
 * The agent PKI's root, issuing and gateway server CA, the PostgreSQL CA, and
 * the certificate expiry of every node that can still connect. Public
 * certificates only: the columns that name a private key's secret are never
 * selected.
 */
export async function readCertificates(q: Queryable): Promise<CertificatesRead> {
  const authorities: CertificateFacts[] = []
  const notRecorded: { role: CertificateRole }[] = []
  const pki = await q.query(
    'nodes.read.pki_certificates',
    'SELECT root_certificate, issuing_ca_certificate, server_ca_certificate FROM nodes.pki',
  )
  const row = pki.rows[0]
  if (row === undefined) {
    notRecorded.push({ role: 'root_ca' }, { role: 'issuing_ca' }, { role: 'gateway_server_ca' })
  } else {
    authorities.push(
      certificateFacts('root_ca', row.bytes('root_certificate')),
      certificateFacts('issuing_ca', row.bytes('issuing_ca_certificate')),
      certificateFacts('gateway_server_ca', row.bytes('server_ca_certificate')),
    )
  }
  const postgres = await q.query(
    'nodes.read.postgres_ca_certificate',
    'SELECT certificate FROM nodes.postgres_ca',
  )
  const ca = postgres.rows[0]
  if (ca === undefined) notRecorded.push({ role: 'postgres_ca' })
  else authorities.push(certificateFacts('postgres_ca', ca.bytes('certificate')))

  const nodes = await q.query(
    'nodes.read.node_certificates',
    `SELECT node_id, server_id, state, certificate_expires_at, heartbeat
       FROM nodes.nodes WHERE state = ANY($1::text[]) ORDER BY node_id LIMIT $2`,
    [CONNECTABLE, NODE_LIMIT + 1],
  )
  return {
    authorities,
    notRecorded,
    nodes: nodes.rows.slice(0, NODE_LIMIT).map((n) => ({
      nodeId: n.text('node_id'),
      serverId: n.text('server_id'),
      state: n.text('state'),
      certificateExpiresAt: n.date('certificate_expires_at').toISOString(),
      serverCertificates: reportedServerCertificates(n.json('heartbeat')),
    })),
    nodesTruncated: nodes.rows.length > NODE_LIMIT,
  }
}

// ----- agent connections (installation health) -----

export interface AgentConnections {
  /** Nodes that are or will be connected: pending binding, active or degraded. */
  readonly enrolled: number
  /** Of those, active or degraded with a heartbeat within four intervals (the `offline` rule). */
  readonly connected: number
  /** The newest heartbeat any node reported, or `null`. */
  readonly lastHeartbeatAt: string | null
}

export async function agentConnections(q: Queryable): Promise<AgentConnections> {
  const { rows } = await q.query(
    'nodes.read.connections',
    `SELECT count(*)::int AS enrolled,
            count(*) FILTER (
              WHERE state IN ('active', 'degraded')
                AND last_heartbeat_at > clock_timestamp() - make_interval(secs => $1)
            )::int AS connected,
            max(last_heartbeat_at) AS last_heartbeat_at
       FROM nodes.nodes WHERE state = ANY($2::text[])`,
    [OFFLINE_AFTER_MS / 1000, CONNECTABLE],
  )
  const row = rows[0]
  return {
    enrolled: row?.int('enrolled') ?? 0,
    connected: row?.int('connected') ?? 0,
    lastHeartbeatAt: row?.dateOrNull('last_heartbeat_at')?.toISOString() ?? null,
  }
}

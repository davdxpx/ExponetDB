import {
  AUDIT_EXPORT_FORMAT,
  AUDIT_EXPORT_MAX_EVENTS,
  type AuditExportHeader,
  AuditExportHeaderSchema,
} from '@exponetdb/contracts'
import type { Tx } from '@exponetdb/control-store'
import { RegistryError } from '@exponetdb/registry'

/**
 * The audit export (audit.md §5.1, owner decision 2026-10-13): the stored
 * events verbatim, so that a verifier outside ExponetDB can recompute `ac1`.
 * `searchAuditEvents` projects parts of an event away; this does not.
 *
 * The page is built in memory before the first byte is sent: the header comes
 * first and carries `count`, `firstSeq`, `lastSeq` and `more`, which are known
 * only after the read. A page is at most `AUDIT_EXPORT_MAX_EVENTS` events and
 * at most `MAX_PAGE_BYTES` of event text (an event is at most 64 KiB), so a
 * page of unusually large events is shorter and `more` says so.
 */
export const MAX_PAGE_BYTES = 32 * 1024 * 1024
const CHUNK = 1_000
const MAX_CHECKPOINTS = 50
const CURSOR_PREFIX = 'x1_'

export interface AuditExportQuery {
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

export interface AuditExportLine {
  readonly seq: number
  readonly prevHash: string
  readonly hash: string
  /** The stored event text (JCS), embedded as it is. */
  readonly event: string
}

export interface AuditExportPage {
  readonly header: AuditExportHeader
  readonly events: readonly AuditExportLine[]
}

type Bound =
  | { readonly kind: 'seq'; readonly seq: number }
  | { readonly kind: 'time'; readonly at: string }

function invalid(path: string, message: string): RegistryError {
  return new RegistryError('VALIDATION_FAILED', { errors: [{ path, code: 'invalid', message }] })
}

function boundOf(path: string, raw: string | undefined): Bound | undefined {
  if (raw === undefined) return undefined
  if (/^[0-9]+$/.test(raw)) {
    const seq = Number(raw)
    if (!Number.isSafeInteger(seq) || seq < 1) throw invalid(path, 'Not a valid sequence number.')
    return { kind: 'seq', seq }
  }
  if (Number.isNaN(Date.parse(raw))) throw invalid(path, 'Not a valid time.')
  return { kind: 'time', at: raw }
}

function cursorOf(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const text = raw.startsWith(CURSOR_PREFIX)
    ? Buffer.from(raw.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')
    : ''
  if (!/^[1-9][0-9]{0,15}$/.test(text)) throw invalid('/cursor', 'Unknown cursor.')
  return Number(text)
}

const encodeCursor = (seq: number): string =>
  CURSOR_PREFIX + Buffer.from(String(seq), 'utf8').toString('base64url')

/** Reads one page inside the caller's transaction (which also writes the `audit.export` event). */
export async function readAuditExport(
  tx: Tx,
  query: AuditExportQuery,
  nowIso: string,
): Promise<AuditExportPage> {
  const from = boundOf('/from', query.from)
  const to = boundOf('/to', query.to)
  if (from !== undefined && to !== undefined) {
    const empty =
      from.kind === 'seq' && to.kind === 'seq'
        ? from.seq >= to.seq
        : from.kind === 'time' && to.kind === 'time'
          ? Date.parse(from.at) >= Date.parse(to.at)
          : false
    if (empty) throw invalid('/to', '`to` (exclusive) must be after `from`.')
  }
  const after = cursorOf(query.cursor)
  const limit = Math.min(
    Math.max(1, Math.trunc(query.limit ?? AUDIT_EXPORT_MAX_EVENTS)),
    AUDIT_EXPORT_MAX_EVENTS,
  )
  const fromTime = from?.kind === 'time' ? from.at : null
  const toTime = to?.kind === 'time' ? to.at : null
  const fromSeq = from?.kind === 'seq' ? from.seq : null
  const toSeq = to?.kind === 'seq' ? to.seq : null

  const events: AuditExportLine[] = []
  let bytes = 0
  let more = false
  let last = after
  scan: while (true) {
    const want = Math.min(CHUNK, limit - events.length)
    const { rows } = await tx.query(
      'application.audit.export',
      `SELECT seq, prev_hash, hash, event FROM audit.audit_events
        WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
          AND ($2::timestamptz IS NULL OR occurred_at < $2)
          AND ($3::bigint IS NULL OR seq >= $3)
          AND ($4::bigint IS NULL OR seq < $4)
          AND ($5::bigint IS NULL OR seq > $5)
        ORDER BY seq ASC
        LIMIT $6`,
      [fromTime, toTime, fromSeq, toSeq, last, want + 1],
    )
    for (const row of rows.slice(0, want)) {
      const event = row.text('event')
      const size = Buffer.byteLength(event, 'utf8')
      if (events.length > 0 && bytes + size > MAX_PAGE_BYTES) {
        more = true
        break scan
      }
      bytes += size
      events.push({
        seq: row.int('seq'),
        prevHash: row.text('prev_hash'),
        hash: row.text('hash'),
        event,
      })
    }
    last = events.at(-1)?.seq ?? last
    // The look-ahead row is in the range: more exists. At the page size it ends the page.
    if (rows.length <= want) break
    if (events.length >= limit) {
      more = true
      break
    }
  }
  const firstSeq = events[0]?.seq ?? null
  const lastSeq = events.at(-1)?.seq ?? null
  const anchors =
    firstSeq === null || lastSeq === null
      ? []
      : (
          await tx.query(
            'application.audit.export.checkpoints',
            `SELECT seq, hash, created_at FROM audit.audit_chain_checkpoints
              WHERE seq >= $1 AND seq <= $2 ORDER BY seq ASC LIMIT $3`,
            [Math.max(1, firstSeq - 1), lastSeq, MAX_CHECKPOINTS],
          )
        ).rows.map((r) => ({
          seq: r.int('seq'),
          hash: r.text('hash') as never,
          createdAt: r.date('created_at').toISOString(),
        }))
  const header = AuditExportHeaderSchema.parse({
    type: 'header',
    format: AUDIT_EXPORT_FORMAT,
    chain: 'ac1',
    from: query.from ?? null,
    to: query.to ?? null,
    firstSeq,
    lastSeq,
    count: events.length,
    more,
    nextCursor: more && lastSeq !== null ? encodeCursor(lastSeq) : null,
    checkpoints: anchors,
    generatedAt: nowIso,
  })
  return { header, events }
}

/**
 * The NDJSON body: the header line, then one line per event. The event text
 * is embedded unchanged, so a verifier that parses the line and canonicalizes
 * `event` (RFC 8785) gets the text `ac1` hashed. Every line ends with LF; a
 * JCS text contains no raw LF.
 */
export function auditExportNdjson(page: AuditExportPage): string {
  const lines = [JSON.stringify(page.header)]
  for (const e of page.events) {
    lines.push(
      `{"type":"event","seq":${e.seq},"prevHash":${JSON.stringify(e.prevHash)},"hash":${JSON.stringify(e.hash)},"event":${e.event}}`,
    )
  }
  return `${lines.join('\n')}\n`
}

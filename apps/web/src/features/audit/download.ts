/**
 * The audit export file (`exponetdb.audit-export/v1`, audit.md §5.1): the
 * header line the page needs to name the part and offer the next one, and
 * the browser download of the text as it came (never changed, never parsed
 * beyond the header). The download goes through a `Blob` and a temporary
 * same-origin object URL on an `a[download]` that is removed at once; the
 * file is never kept in the page, the query cache or storage.
 */
export interface ExportHeader {
  readonly firstSeq: number | null
  readonly lastSeq: number | null
  readonly count: number
  readonly more: boolean
  readonly nextCursor: string | null
}

const CURSOR = /^[A-Za-z0-9_-]{1,512}$/

function seq(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** The header of an export page, or undefined when the first line is not one. */
export function exportHeader(text: string): ExportHeader | undefined {
  const end = text.indexOf('\n')
  const first = end === -1 ? text : text.slice(0, end)
  let parsed: unknown
  try {
    parsed = JSON.parse(first)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const header = parsed as Readonly<Record<string, unknown>>
  if (header['type'] !== 'header' || header['format'] !== 'exponetdb.audit-export/v1') {
    return undefined
  }
  const count = seq(header['count'])
  const cursor = header['nextCursor']
  const more = header['more'] === true
  if (count === null) return undefined
  const nextCursor = typeof cursor === 'string' && CURSOR.test(cursor) ? cursor : null
  return {
    firstSeq: seq(header['firstSeq']),
    lastSeq: seq(header['lastSeq']),
    count,
    more: more && nextCursor !== null,
    nextCursor,
  }
}

/** `exponetdb-audit-<first>-<last>.ndjson` from the header's numbers only. */
export function exportFileName(header: ExportHeader): string {
  if (header.firstSeq === null || header.lastSeq === null) return 'exponetdb-audit-empty.ndjson'
  return `exponetdb-audit-${String(header.firstSeq)}-${String(header.lastSeq)}.ndjson`
}

/** Hands `text` to the browser as a file download. */
export function saveFile(text: string, name: string, type = 'application/x-ndjson'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  anchor.hidden = true
  document.body.append(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    // The click started the download; the object URL is released after this task.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

import { canonicalize, encodeUtf8, InvariantError, toJsonValue } from '@exponetdb/kernel'
import type { CheckpointDocument } from '../checkpoints.ts'

/** Canonical bytes of a checkpoint document and its object key. */
export function checkpointBytes(document: CheckpointDocument): Uint8Array {
  const json = toJsonValue(document)
  const text = json.ok ? canonicalize(json.value) : undefined
  if (text === undefined || !text.ok) {
    throw new InvariantError('checkpoint documents are JSON')
  }
  return encodeUtf8(`${text.value}\n`)
}

export function checkpointKey(document: CheckpointDocument, prefix = ''): string {
  const seq = String(document.seq).padStart(20, '0')
  const base = `${document.installationId}/audit-checkpoints/${seq}.json`
  return prefix.length === 0 ? base : `${prefix.replace(/\/+$/, '')}/${base}`
}

export class CheckpointExportError extends Error {
  override readonly name = 'CheckpointExportError'
  readonly code = 'audit_export_failed'
  /** HTTP status or file-system code; never response bodies or credentials. */
  readonly detailCode: string
  constructor(detailCode: string) {
    super('The audit checkpoint could not be exported.')
    this.detailCode = /^[A-Za-z0-9_]{1,32}$/.test(detailCode) ? detailCode : 'unknown'
  }
}

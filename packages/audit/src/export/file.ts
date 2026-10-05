import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CheckpointDocument, CheckpointExporter, ExportedCheckpoint } from '../checkpoints.ts'
import { CheckpointExportError, checkpointBytes, checkpointKey } from './document.ts'

/**
 * Writes checkpoints as files under a directory. Off-host only when the
 * directory is a mount of another host or an append-only store; otherwise a
 * development and test sink. Never overwrites a different checkpoint.
 */
export function fileCheckpointExporter(directory: string): CheckpointExporter {
  return {
    sink: 'file',
    async export(document: CheckpointDocument): Promise<ExportedCheckpoint> {
      const key = checkpointKey(document)
      const path = join(directory, key)
      const bytes = checkpointBytes(document)
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
        if (code === 'EEXIST') {
          const existing = new Uint8Array(await readFile(path))
          if (Buffer.compare(existing, bytes) === 0) {
            return { location: `file:${key}` }
          }
          throw new CheckpointExportError('conflict')
        }
        throw new CheckpointExportError(typeof code === 'string' ? code : 'io')
      }
      return { location: `file:${key}` }
    },
  }
}

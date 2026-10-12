import type { CommandResult } from '../output/model.ts'
import { progressRecord } from '../output/render.ts'
import { cleanLine } from '../output/text.ts'
import type { Io, RunContext } from './types.ts'

export type { Io, RunContext }

export function contextFor(base: Omit<RunContext, 'progress' | 'hint'>): RunContext {
  return {
    ...base,
    progress(line, data) {
      if (base.format === 'ndjson') {
        base.io.stdout(`${progressRecord(base.command, data ?? { message: line })}\n`)
      } else if (base.format === 'table' && !base.global.quiet) {
        base.io.stderr(`${cleanLine(line)}\n`)
      }
    },
    hint(line) {
      if (base.format === 'table' && !base.global.quiet) base.io.stderr(`${cleanLine(line)}\n`)
    },
  }
}

export type { CommandResult }

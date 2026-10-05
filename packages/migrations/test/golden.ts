import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { z } from 'zod'

/**
 * Reads a golden vector file from `tooling/golden` (data only, never imported
 * as code) and validates it against `schema`, so a vector of the wrong shape
 * fails loudly instead of being trusted.
 */
export function loadGolden<S extends z.ZodType>(file: string, schema: S): z.output<S> {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'tooling', 'golden', file)
    if (existsSync(candidate)) {
      const raw: unknown = JSON.parse(readFileSync(candidate, 'utf8'))
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`golden file ${file} does not match its schema: ${parsed.error.message}`)
      }
      return parsed.data
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`golden file not found: ${file}`)
    }
    dir = parent
  }
}

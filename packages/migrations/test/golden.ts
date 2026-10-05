import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Reads a golden vector file from `tooling/golden` (data only, never imported as code). */
export function loadGolden<T>(file: string): T {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'tooling', 'golden', file)
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf8')) as T
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`golden file not found: ${file}`)
    }
    dir = parent
  }
}

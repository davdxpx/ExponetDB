import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonObject } from '@exponetdb/kernel'

/**
 * The fp1 and schema-diff golden vectors (`tooling/golden/fp1.json`,
 * `schema-diff.json`; data only, never imported as code). The shapes are
 * checked as they are read, so a malformed vector fails loudly.
 */
export interface Fp1Vector {
  readonly id: string
  readonly description: string
  readonly input: {
    readonly pgMajor: number
    readonly superuser: string
    readonly roles: readonly string[]
    readonly setup: readonly string[]
    readonly scope: {
      readonly includeSchemas?: readonly string[]
      readonly excludeSchemas?: readonly string[]
    }
  }
  readonly expected: {
    readonly fingerprint: string
    readonly entryCount: number
    readonly document: JsonObject
  }
}

interface Ref {
  readonly class: string
  readonly key: readonly string[]
  readonly securityRelevant: boolean
}

export interface DiffVector {
  readonly id: string
  readonly description: string
  readonly input: { readonly left: string; readonly right: string }
  readonly expected: {
    readonly comparable: boolean
    readonly added: readonly Ref[]
    readonly removed: readonly Ref[]
    readonly changed: readonly (Ref & { readonly attributes: readonly string[] })[]
    readonly documentationChanged: readonly (readonly [string, readonly string[]])[]
    readonly matched: number
  }
}

function read(file: string): { vectors: unknown[] } {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'tooling', 'golden', file)
    if (existsSync(candidate)) {
      const raw = JSON.parse(readFileSync(candidate, 'utf8')) as { vectors?: unknown }
      if (!Array.isArray(raw.vectors) || raw.vectors.length === 0) {
        throw new Error(`golden file ${file} has no vectors`)
      }
      return { vectors: raw.vectors }
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`golden file not found: ${file}`)
    dir = parent
  }
}

function assertShape(ok: boolean, file: string, id: unknown): void {
  if (!ok)
    throw new Error(`golden file ${file}: vector ${String(id)} does not have the expected shape`)
}

export function fp1Vectors(): readonly Fp1Vector[] {
  return read('fp1.json').vectors.map((v) => {
    const x = v as Fp1Vector
    assertShape(
      typeof x.id === 'string' &&
        Number.isInteger(x.input?.pgMajor) &&
        typeof x.input.superuser === 'string' &&
        Array.isArray(x.input.roles) &&
        Array.isArray(x.input.setup) &&
        typeof x.input.scope === 'object' &&
        /^fp1:\d+:[0-9a-f]{64}$/.test(x.expected?.fingerprint ?? '') &&
        Number.isInteger(x.expected.entryCount) &&
        typeof x.expected.document === 'object',
      'fp1.json',
      x.id,
    )
    return x
  })
}

export function diffVectors(): readonly DiffVector[] {
  return read('schema-diff.json').vectors.map((v) => {
    const x = v as DiffVector
    assertShape(
      typeof x.id === 'string' &&
        typeof x.input?.left === 'string' &&
        typeof x.input.right === 'string' &&
        typeof x.expected?.comparable === 'boolean' &&
        Array.isArray(x.expected.added) &&
        Array.isArray(x.expected.removed) &&
        Array.isArray(x.expected.changed) &&
        Array.isArray(x.expected.documentationChanged) &&
        Number.isInteger(x.expected.matched),
      'schema-diff.json',
      x.id,
    )
    return x
  })
}

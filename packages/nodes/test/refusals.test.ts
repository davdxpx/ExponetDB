import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { errorDefinition } from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'

/**
 * Every registry-conflict reason a node refusal names is a reason the error
 * catalog lists, so a client reads each one from the contract
 * (`x-extensible-enum`), never only from the code that throws it.
 */
const SRC = join(import.meta.dirname, '..', 'src')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [readFileSync(join(dir, e.name), 'utf8')]
        : [],
  )
}

describe('node refusal reasons', () => {
  it('are listed by the catalog', () => {
    const thrown = new Set(
      sources(SRC).flatMap((text) =>
        [
          ...text.matchAll(
            /new NodeError\(\s*'REGISTRY_CONFLICT',\s*\{\s*reason:\s*'([a-z0-9_]+)'/g,
          ),
        ].map((m) => m[1] ?? ''),
      ),
    )
    expect(thrown.size).toBeGreaterThan(10)
    // The catalog's zod schema: its metadata names the known reasons.
    const details = errorDefinition('REGISTRY_CONFLICT').details as unknown as {
      readonly shape: { readonly reason: { meta(): Record<string, unknown> | undefined } }
    }
    const listed = new Set(details.shape.reason.meta()?.['x-extensible-enum'] as readonly string[])
    expect([...thrown].filter((r) => !listed.has(r))).toEqual([])
  })
})

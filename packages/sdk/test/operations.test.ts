import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OPERATIONS as FULL } from '../src/index.ts'
import { OPERATIONS } from '../src/operations.ts'

const here = dirname(fileURLToPath(import.meta.url))

describe('@exponetdb/sdk/operations', () => {
  it('is the same generated table the full SDK exports', () => {
    expect(OPERATIONS).toBe(FULL)
    expect(Object.keys(OPERATIONS).length).toBeGreaterThan(100)
  })

  it('imports nothing but the generated module, which imports nothing', () => {
    const entry = readFileSync(join(here, '..', 'src', 'operations.ts'), 'utf8')
    const imports = [...entry.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(imports).toEqual(['./generated/api.ts', './generated/api.ts'])
    const generated = readFileSync(join(here, '..', 'src', 'generated', 'api.ts'), 'utf8')
    expect(generated).not.toMatch(/^\s*import\s/m)
    expect(generated).not.toMatch(/\brequire\(|\bimport\(|^\s*export\s.*\sfrom\s/m)
  })

  it('is exported as a package subpath', () => {
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    expect(manifest.exports['./operations']).toEqual({
      '@exponetdb/source': './src/operations.ts',
      types: './dist/operations.d.ts',
      default: './dist/operations.js',
    })
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { importViolations, unpinnedActions } from '../boundaries/check.ts'
import { allowedComponents } from '../boundaries/rules.mjs'

/**
 * The boundary checker must fail on real violations, not only pass on a clean
 * tree. These cases build a small throwaway tree with relative imports (so
 * the path rules apply) and module-name imports (so the name rules apply).
 */
let base = ''
const files: Record<string, string> = {
  'packages/kernel/src/ok.ts': 'export const ok = 1\n',
  'packages/kernel/src/up.ts':
    "import { b } from '../../contracts/src/b.ts'\nexport const up = b\n",
  'packages/kernel/src/byname.ts': "import { b } from '@exponetdb/contracts'\nexport const n = b\n",
  'packages/contracts/src/b.ts':
    "import { ok } from '../../kernel/src/ok.ts'\nexport const b = ok\n",
  'packages/contracts/src/cycle-a.ts': "import { cb } from './cycle-b.ts'\nexport const ca = cb\n",
  'packages/contracts/src/cycle-b.ts': "import { ca } from './cycle-a.ts'\nexport const cb = ca\n",
  'packages/contracts/src/gen.ts':
    "import doc from '../generated/openapi.json' with { type: 'json' }\nexport const g = doc\n",
  'packages/contracts/generated/openapi.json': '{}\n',
  'packages/contracts/src/tool.ts':
    "import { t } from '../../../tooling/x.ts'\nexport const u = t\n",
  'tooling/x.ts': 'export const t = 1\n',
  'packages/migrations/src/format/f.ts': "import { e } from '../engine/e.ts'\nexport const f = e\n",
  'packages/migrations/src/engine/e.ts': 'export const e = 1\n',
  'packages/ui/src/u.ts': "import { b } from '../../contracts/src/b.ts'\nexport const ui = b\n",
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'exdb-boundary-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true })
    writeFileSync(join(base, path), content)
  }
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

async function violations(): Promise<string[]> {
  const found = await importViolations(base, ['packages', 'tooling'])
  return found.map((v) => `${v.from} -> ${v.to} : ${v.rule.name}`)
}

describe('boundary checker', () => {
  it('reports every planted violation and nothing for allowed edges', async () => {
    const found = await violations()
    const has = (from: string, rule: string): boolean =>
      found.some((v) => v.startsWith(from) && v.endsWith(rule))
    expect(has('packages/kernel/src/up.ts', 'boundary:kernel'), found.join('\n')).toBe(true)
    expect(has('packages/kernel/src/byname.ts', 'boundary-by-name:kernel'), found.join('\n')).toBe(
      true,
    )
    expect(has('packages/contracts/src/cycle-a.ts', 'no-circular'), found.join('\n')).toBe(true)
    expect(has('packages/contracts/src/gen.ts', 'no-generated-import'), found.join('\n')).toBe(true)
    expect(has('packages/contracts/src/tool.ts', 'no-product-to-tooling'), found.join('\n')).toBe(
      true,
    )
    expect(
      has('packages/migrations/src/format/f.ts', 'boundary:migrations/format'),
      found.join('\n'),
    ).toBe(true)
    expect(has('packages/ui/src/u.ts', 'boundary:ui'), found.join('\n')).toBe(true)
    expect(
      found.some((v) => v.startsWith('packages/contracts/src/b.ts')),
      found.join('\n'),
    ).toBe(false)
  })
})

describe('allowed graph', () => {
  it('keeps the foundations free of upward edges', () => {
    expect(allowedComponents('kernel')).toEqual([])
    expect(allowedComponents('contracts')).toEqual(['kernel'])
    expect([...allowedComponents('migrations/format')].sort()).toEqual(['contracts', 'kernel'])
  })

  it('limits interfaces to application, auth, contracts and observability (C-9)', () => {
    expect([...allowedComponents('server/interfaces')].sort()).toEqual([
      'application',
      'auth',
      'contracts',
      'kernel',
      'observability',
    ])
  })

  it('keeps UI packages data-agnostic: no contracts, no sdk', () => {
    for (const ui of ['ui', 'ui-patterns', 'ui-data', 'tokens', 'icons']) {
      expect(allowedComponents(ui), ui).not.toContain('contracts')
      expect(allowedComponents(ui), ui).not.toContain('sdk')
    }
  })

  it('never lets a domain package import application or postgres reach control-store', () => {
    for (const domain of [
      'registry',
      'operations',
      'nodes',
      'backups',
      'diagnostics',
      'policy',
      'audit',
      'secrets',
      'auth',
    ]) {
      expect(allowedComponents(domain), domain).not.toContain('application')
    }
    expect(allowedComponents('postgres')).not.toContain('control-store')
    expect(allowedComponents('postgres')).not.toContain('registry')
  })
})

describe('workflow action pins', () => {
  it('accepts full commit SHAs and refuses tags, branches and short SHAs', () => {
    const workflow = [
      '      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0',
      "      - uses: 'actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16'",
      '      - uses: ./local-action',
      '      - uses: actions/checkout@v5',
      '        uses: oven-sh/setup-bun@main',
      '      - uses: actions/setup-node@a0853c2',
      '      - uses: actions/setup-node@A0853C24544627F65DDF259ABE73B1D18A591444',
    ].join('\n')
    expect(unpinnedActions(workflow)).toEqual([
      'line 4: actions/checkout@v5',
      'line 5: oven-sh/setup-bun@main',
      'line 6: actions/setup-node@a0853c2',
      'line 7: actions/setup-node@A0853C24544627F65DDF259ABE73B1D18A591444',
    ])
  })
})

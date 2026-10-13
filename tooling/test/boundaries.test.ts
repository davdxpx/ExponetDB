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
  // The SDK imports its own generated types, and only those; consumers use its entry point.
  'packages/sdk/src/generated/api.ts': 'export const OPERATIONS = {}\n',
  'packages/sdk/src/client.ts':
    "import { OPERATIONS } from './generated/api.ts'\nexport const c = OPERATIONS\n",
  'packages/sdk/src/spec.ts':
    "import doc from '../../contracts/generated/openapi.json' with { type: 'json' }\nexport const s = doc\n",
  'apps/web/src/types.ts':
    "import { OPERATIONS } from '../../../packages/sdk/src/generated/api.ts'\nexport const t = OPERATIONS\n",
  'packages/contracts/src/tool.ts':
    "import { t } from '../../../tooling/x.ts'\nexport const u = t\n",
  'tooling/x.ts': 'export const t = 1\n',
  'packages/migrations/src/format/f.ts': "import { e } from '../engine/e.ts'\nexport const f = e\n",
  'packages/migrations/src/engine/e.ts': 'export const e = 1\n',
  'packages/ui/src/u.ts': "import { b } from '../../contracts/src/b.ts'\nexport const ui = b\n",
  // Wave 8: the browser packages stay browser-safe and layered; the Web App reaches the SDK
  // only through its browser subpath and the contracts only for types.
  'packages/sdk/src/operations.ts': "export { OPERATIONS } from './generated/api.ts'\n",
  'apps/web/src/ops.ts':
    "import { OPERATIONS } from '../../../packages/sdk/src/operations.ts'\nexport const o = OPERATIONS\n",
  'apps/web/src/sdk-main.ts':
    "import { c } from '../../../packages/sdk/src/client.ts'\nexport const m = c\n",
  'apps/web/src/runtime-contracts.ts':
    "import { b } from '../../../packages/contracts/src/b.ts'\nexport const r = b\n",
  'apps/web/src/type-contracts.ts':
    "import type { b } from '../../../packages/contracts/src/b.ts'\nexport type T = typeof b\n",
  'packages/ui/src/node.tsx':
    "import { readFileSync } from 'node:fs'\nexport const n = () => <p>{String(readFileSync)}</p>\n",
  'packages/ui-data/src/d.ts': 'export const d = 1\n',
  'packages/ui-patterns/src/up.tsx':
    "import { d } from '../../ui-data/src/d.ts'\nexport const P = () => <p>{d}</p>\n",
  'apps/design-system/src/sdk.ts':
    "import { c } from '../../../packages/sdk/src/client.ts'\nexport const ds = c\n",
  // Wave 2: the persistence boundary never reaches up; audit and policy never import operations.
  'packages/operations/src/op.ts': 'export const op = 1\n',
  'packages/control-store/src/up.ts':
    "import { op } from '../../operations/src/op.ts'\nexport const cs = op\n",
  'packages/control-store/src/testing/harness.ts': 'export const harness = 1\n',
  'packages/control-store/src/ok.ts':
    "import { harness } from './testing/harness.ts'\nexport const notOk = harness\n",
  'packages/audit/src/up.ts':
    "import { op } from '../../operations/src/op.ts'\nexport const a = op\n",
  'packages/policy/src/up.ts':
    "import { op } from '../../operations/src/op.ts'\nexport const p = op\n",
  'packages/secrets/src/up.ts': "import { a } from '../../audit/src/up.ts'\nexport const s = a\n",
  'packages/operations/src/fine.ts':
    "import { p } from '../../policy/src/up.ts'\nimport { a } from '../../audit/src/up.ts'\nexport const f = [p, a]\n",
  // apps/server: interfaces and commands never reach the Control Store; only the composition root wires it.
  'packages/control-store/src/store.ts': 'export const store = 1\n',
  'apps/server/src/interfaces/http/sql.ts':
    "import { store } from '../../../../../packages/control-store/src/store.ts'\nexport const i = store\n",
  'apps/server/src/commands/direct.ts':
    "import { store } from '../../../../packages/control-store/src/store.ts'\nexport const c = store\n",
  'apps/server/src/roles/direct.ts':
    "import { op } from '../../../../packages/operations/src/op.ts'\nexport const r = op\n",
  'apps/server/src/composition/wire.ts':
    "import { store } from '../../../../packages/control-store/src/store.ts'\nimport { op } from '../../../../packages/operations/src/op.ts'\nexport const w = [store, op]\n",
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
  const found = await importViolations(base, ['packages', 'apps', 'tooling'])
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
    expect(
      found.some((v) => v.startsWith('packages/sdk/src/client.ts')),
      found.join('\n'),
    ).toBe(false)
    expect(has('packages/sdk/src/spec.ts', 'sdk-own-generated-only'), found.join('\n')).toBe(true)
    expect(has('apps/web/src/types.ts', 'no-generated-import'), found.join('\n')).toBe(true)
    expect(has('packages/contracts/src/tool.ts', 'no-product-to-tooling'), found.join('\n')).toBe(
      true,
    )
    expect(
      has('packages/migrations/src/format/f.ts', 'boundary:migrations/format'),
      found.join('\n'),
    ).toBe(true)
    expect(has('packages/ui/src/u.ts', 'boundary:ui'), found.join('\n')).toBe(true)
    expect(
      found.some((v) => v.startsWith('apps/web/src/ops.ts')),
      found.join('\n'),
    ).toBe(false)
    expect(has('apps/web/src/sdk-main.ts', 'web-sdk-operations-only'), found.join('\n')).toBe(true)
    expect(
      has('apps/web/src/runtime-contracts.ts', 'web-contracts-types-only'),
      found.join('\n'),
    ).toBe(true)
    expect(
      found.some((v) => v.startsWith('apps/web/src/type-contracts.ts')),
      found.join('\n'),
    ).toBe(false)
    expect(
      has('packages/ui/src/node.tsx', 'no-node-builtins-in-browser-safe-code'),
      found.join('\n'),
    ).toBe(true)
    expect(has('packages/ui-patterns/src/up.tsx', 'boundary:ui-patterns'), found.join('\n')).toBe(
      true,
    )
    expect(has('apps/design-system/src/sdk.ts', 'boundary:design-system'), found.join('\n')).toBe(
      true,
    )
    expect(
      has('packages/control-store/src/up.ts', 'boundary:control-store'),
      found.join('\n'),
    ).toBe(true)
    expect(
      has('packages/control-store/src/ok.ts', 'no-testing-harness-in-product'),
      found.join('\n'),
    ).toBe(true)
    expect(has('packages/audit/src/up.ts', 'boundary:audit'), found.join('\n')).toBe(true)
    expect(has('packages/policy/src/up.ts', 'boundary:policy'), found.join('\n')).toBe(true)
    expect(has('packages/secrets/src/up.ts', 'boundary:secrets'), found.join('\n')).toBe(true)
    expect(
      found.some((v) => v.startsWith('packages/operations/src/fine.ts') && v.includes('boundary')),
      found.join('\n'),
    ).toBe(false)
    expect(
      found.some((v) => v.startsWith('packages/contracts/src/b.ts')),
      found.join('\n'),
    ).toBe(false)
    expect(
      has('apps/server/src/interfaces/http/sql.ts', 'boundary:server/interfaces'),
      found.join('\n'),
    ).toBe(true)
    expect(
      has('apps/server/src/commands/direct.ts', 'boundary:server/commands'),
      found.join('\n'),
    ).toBe(true)
    expect(has('apps/server/src/roles/direct.ts', 'boundary:server/roles'), found.join('\n')).toBe(
      true,
    )
    expect(
      found.some(
        (v) => v.startsWith('apps/server/src/composition/wire.ts') && v.includes('boundary'),
      ),
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
    for (const ui of ['ui', 'ui-patterns', 'ui-data', 'tokens', 'icons', 'design-system']) {
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

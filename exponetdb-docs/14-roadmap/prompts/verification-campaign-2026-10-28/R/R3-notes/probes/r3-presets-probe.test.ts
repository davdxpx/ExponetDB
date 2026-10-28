/**
 * Block R, tester R3, TC-074 / E11: declared scopes against the action scopes, and the presets.
 * Copy to apps/cli/test/r3-presets-probe.test.ts; `bunx vitest run test/r3-presets-probe.test.ts` in apps/cli.
 */
import { actionDefinition, type ActionId } from '@exponetdb/contracts'
import { describe, it } from 'vitest'
import { COMMANDS } from '../src/commands/index.ts'
import { PRESET_NAMES, SCOPE_PRESETS } from '../src/presets.ts'

const out = (name: string, data: unknown) => process.stdout.write(`R3PROBE ${name} ${JSON.stringify(data)}\n`)

describe('TC-074 / E11', () => {
  it('declared scopes against the action scope rule', () => {
    const mismatches: unknown[] = []
    let checked = 0
    for (const c of COMMANDS) {
      if (c.locality !== 'remote' || c.action === undefined) continue
      const rule = actionDefinition(c.action as ActionId).scope
      if (rule.kind !== 'fixed') continue
      checked += 1
      const declared = [...(c.scopes ?? [])].sort()
      if (declared.length !== 1 || declared[0] !== rule.scope) {
        mismatches.push({ command: c.path.join(' '), action: c.action, declared, server: rule.scope })
      }
    }
    out('tc074.scope-mismatch', { checked, mismatchCount: mismatches.length, mismatches })
  })
  it('the node-management scopes across the presets', () => {
    const want = ['nodes.plan', 'registry.manage', 'restore.plan', 'backups.run']
    out(
      'tc074.preset-matrix',
      Object.fromEntries(PRESET_NAMES.map((p) => [p, want.filter((s) => (SCOPE_PRESETS[p].scopes as readonly string[]).includes(s))])),
    )
  })
})

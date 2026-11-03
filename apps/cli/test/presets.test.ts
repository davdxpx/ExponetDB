import {
  actionDefinition,
  isActionId,
  isDeviceFlowScope,
  isScopeGrantableTo,
  scopeDefinition,
} from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import { presetFrom } from '../src/commands/auth.ts'
import { COMMANDS } from '../src/commands/index.ts'
import { run } from '../src/main.ts'
import {
  deviceRefused,
  isCliScope,
  PRESET_NAMES,
  rememberable,
  SCOPE_PRESETS,
  scopeHint,
  scopeList,
  scopeReport,
  smallestPresetCovering,
} from '../src/presets.ts'
import { testIo } from './support.ts'

/** The presets against the contract's scope catalog (15-cli/README.md §3). */
describe('scope presets', () => {
  it('hold only scopes the CLI may hold, each once', () => {
    for (const name of PRESET_NAMES) {
      const { scopes } = SCOPE_PRESETS[name]
      expect(new Set(scopes).size, name).toBe(scopes.length)
      for (const s of scopes) expect(isScopeGrantableTo(s, 'cli'), `${name}: ${s}`).toBe(true)
    }
  })

  it('hold a production scope only when the name says :prod', () => {
    for (const name of PRESET_NAMES) {
      const prod = SCOPE_PRESETS[name].scopes.some((s) => scopeDefinition(s).tier === 'prod')
      expect(prod, name).toBe(name.endsWith(':prod'))
    }
  })

  it('never hold the break-glass, recovery, restore or sensitive-read scopes', () => {
    const never = [
      'restore.execute',
      'operations.recover',
      'breakglass.activate',
      'diagnostics.read_sensitive',
      'data.read_sensitive',
    ]
    for (const name of PRESET_NAMES) {
      expect(
        SCOPE_PRESETS[name].scopes.filter((s) => never.includes(s)),
        name,
      ).toEqual([])
    }
  })

  it('cover registry, import and nonprod migrations with admin', () => {
    expect(SCOPE_PRESETS.admin.scopes).toEqual(
      expect.arrayContaining([
        'registry.manage',
        'migrations.plan',
        'migrations.apply:nonprod',
        'migrations.import',
        'access.manage',
      ]),
    )
  })

  it('pass the device flow exactly when no scope needs explicit consent', () => {
    const device = PRESET_NAMES.filter((n) => SCOPE_PRESETS[n].scopes.every(isDeviceFlowScope))
    expect(device).toEqual(['read', 'developer:nonprod', 'operator:nonprod'])
    expect(deviceRefused(SCOPE_PRESETS.admin.scopes)).toContain('registry.manage')
    expect(deviceRefused(SCOPE_PRESETS['developer:prod'].scopes)).toEqual(['migrations.apply:prod'])
    // Fail closed: a string that is not a scope never passes.
    expect(deviceRefused(['targets.read', 'nope'])).toEqual(['nope'])
  })
})

describe('scope helpers', () => {
  it('never remembers a production scope', () => {
    expect(
      rememberable(['targets.read', 'migrations.apply:prod', 'registry.manage', 'nope']),
    ).toEqual(['targets.read', 'registry.manage'])
  })

  it('reports granted scopes against the presets and the last request', () => {
    const report = scopeReport(
      [...SCOPE_PRESETS.read.scopes, 'migrations.plan'],
      ['targets.read', 'registry.manage'],
    )
    expect(report.notGranted).toEqual(['registry.manage'])
    expect(report.presets.find((p) => p.preset === 'read')).toMatchObject({ covered: true })
    expect(report.presets.find((p) => p.preset === 'developer:nonprod')).toEqual({
      preset: 'developer:nonprod',
      covered: false,
      missing: ['migrations.apply:nonprod'],
    })
    expect(scopeReport(['targets.read']).notGranted).toBeNull()
  })

  it('splits a scope string and keeps each scope once', () => {
    expect(scopeList(' targets.read,schema.read  targets.read ')).toEqual([
      'targets.read',
      'schema.read',
    ])
    expect(scopeList('')).toEqual([])
  })

  it('knows the scopes the CLI may hold', () => {
    expect(isCliScope('registry.manage')).toBe(true)
    expect(isCliScope('plans.approve')).toBe(false)
    expect(isCliScope('api')).toBe(false)
    expect(isCliScope('nope')).toBe(false)
  })

  it('suggests the smallest covering preset, never one that adds production', () => {
    expect(smallestPresetCovering(['targets.read'])).toBe('read')
    expect(smallestPresetCovering(['migrations.apply:nonprod'])).toBe('developer:nonprod')
    expect(smallestPresetCovering(['registry.manage'])).toBe('admin')
    expect(smallestPresetCovering(['migrations.apply:prod'])).toBe('developer:prod')
    expect(smallestPresetCovering(['data.read:nonprod'])).toBe('operator:nonprod')
    expect(smallestPresetCovering(['registry.manage', 'migrations.apply:prod'])).toBeUndefined()
    expect(smallestPresetCovering(['data.read_sensitive'])).toBeUndefined()
  })

  it('keeps the granted scopes in the hint and adds the required one', () => {
    expect(scopeHint(['targets.read'], ['registry.manage'], ' --server https://x.test')).toEqual([
      'exponetdb login --server https://x.test --preset admin',
      'exponetdb login --server https://x.test --scope "targets.read registry.manage"',
    ])
    expect(scopeHint(['targets.read', 'data.read_sensitive'], ['schema.read'], '')).toEqual([
      'exponetdb login --scope "targets.read data.read_sensitive schema.read"',
    ])
    // A scope the CLI can never hold is not won by signing in again.
    expect(scopeHint(['targets.read'], ['plans.approve'], '')).toEqual([])
  })
})

/**
 * TC-074 (E11): five `cluster` commands declared `nodes.read`/`nodes.plan` while the server needs
 * `registry.manage`, so a preset that held the declared scope still ended in INSUFFICIENT_SCOPE.
 */
describe('the declared scopes of the commands (TC-074)', () => {
  const remote = COMMANDS.filter(
    (c) => c.locality === 'remote' && c.action !== undefined && c.scopes !== undefined,
  )

  it('hold the fixed scope the server needs for the action', () => {
    const wrong = remote.flatMap((c) => {
      const action = c.action as string
      if (!isActionId(action)) return []
      const rule = actionDefinition(action).scope
      if (rule.kind !== 'fixed') return []
      return (c.scopes as readonly string[]).includes(rule.scope)
        ? []
        : [
            `${c.path.join(' ')}: declares ${(c.scopes as readonly string[]).join(' ')}, needs ${rule.scope}`,
          ]
    })
    expect(wrong).toEqual([])
  })

  it('are held by at least one preset, unless the scope needs explicit consent', () => {
    const held = new Set(PRESET_NAMES.flatMap((n) => SCOPE_PRESETS[n].scopes as readonly string[]))
    const missing = new Set(
      remote
        .flatMap((c) => c.scopes as readonly string[])
        .filter((s) => isCliScope(s) && isDeviceFlowScope(s) && !held.has(s)),
    )
    expect([...missing]).toEqual([])
  })
})

describe('presets in the CLI (TC-074)', () => {
  it('combines several presets into one union', () => {
    const both = presetFrom(['read', 'admin'])
    expect(both).toEqual(expect.arrayContaining(['nodes.read', 'registry.manage']))
    expect(new Set(both).size).toBe(both.length)
    expect(() => presetFrom(['read', 'nope'])).toThrow(/not a preset/)
  })

  it('prints every scope of every preset at 120 columns, cut nowhere', async () => {
    const out: string[] = []
    const code = await run(
      ['auth', 'presets'],
      testIo({ configDir: '/nonexistent', columns: 120, stdout: out }),
    )
    expect(code).toBe(0)
    const text = out.join('')
    expect(text).not.toContain('…')
    expect(text).toContain('nodes.plan')
    for (const name of PRESET_NAMES) {
      for (const scope of SCOPE_PRESETS[name].scopes) expect(text).toContain(scope)
    }
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(120)
  })
})

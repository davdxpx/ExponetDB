import { isDeviceFlowScope, isScopeGrantableTo, scopeDefinition } from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
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

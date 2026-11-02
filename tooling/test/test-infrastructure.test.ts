import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as shared from '../../vitest.shared.ts'
import { ENTRIES } from '../checks/verify-host.ts'

/**
 * Regression guards of the test-infrastructure fixes of the first campaign (VC-131, VC-132): the
 * time zone, the model evals without a key and the names they print. CI runs in UTC and without
 * a key, so a revert of any of them used to be green.
 */
const root = new URL('../../', import.meta.url)

describe('TC-049: tests that format a time expect UTC', () => {
  it('has every shared vitest config run its tests with TZ=UTC', () => {
    const configs = Object.entries(shared).filter(
      (e): e is [string, { test: { env?: Record<string, string> } }] =>
        typeof e[1] === 'object' && e[1] !== null && 'test' in e[1],
    )
    expect(configs.length).toBeGreaterThanOrEqual(5)
    for (const [name, config] of configs) {
      expect(config.test.env?.['TZ'], name).toBe('UTC')
    }
  })
})

describe('TC-050: the model evals', () => {
  const evals = readFileSync(new URL('apps/server/test/mcp-evals.model.test.ts', root), 'utf8')
  const entry = ENTRIES.find((e) => e.command.includes('mcp:evals'))

  it('names, in verify:host, the key variable the test reads', () => {
    expect(entry).toBeDefined()
    const key = /\b(EXDB_EVAL_ANTHROPIC_API_KEY)\b/.exec(entry?.needs ?? '')?.[1]
    expect(key).toBe('EXDB_EVAL_ANTHROPIC_API_KEY')
    expect(evals).toContain(`process.env['${key}']`)
    // The bare name of the vendor's own variable is not what the test reads.
    expect(entry?.needs.replace('EXDB_EVAL_ANTHROPIC_API_KEY', '')).not.toContain(
      'ANTHROPIC_API_KEY',
    )
  })

  it('skips every task without a key, with the NOT RUN message, and exits 0', () => {
    const env = { ...process.env }
    delete env['EXDB_EVAL_ANTHROPIC_API_KEY']
    const run = spawnSync('bunx', ['vitest', 'run', '--config', 'vitest.evals.config.ts'], {
      cwd: new URL('apps/server/', root),
      env,
      encoding: 'utf8',
      timeout: 120_000,
    })
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colors from the report
    const out = `${run.stdout}${run.stderr}`.replace(/\u001b\[[0-9;]*m/g, '')
    expect(run.status, out).toBe(0)
    expect(out).toMatch(/Tests\s+\d+ skipped/)
    expect(out).not.toMatch(/Tests\s+\d+ passed/)
  }, 150_000)
})

import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { startMcpFixture } from './support/mcp-fixture-server.ts'

/**
 * The MCP conformance suite (protocol-baseline.md §6), pinned, against the
 * test composition of `/mcp` (support/mcp-world.ts) on a local port, once
 * per revision: `--requirements` runs exactly what the revision requires,
 * at its own wire version. Every expected failure is listed with its reason
 * in `conformance/expected-failures.<revision>.yaml`; an unexpected failure
 * and a stale entry both fail the run. The fixture adds its token to
 * requests without one: the suite tests the protocol, not authentication.
 */
const SUITE = '@modelcontextprotocol/conformance@0.2.0-alpha.12'
const run = promisify(execFile)

interface Check {
  readonly id?: string
  readonly status?: string
  readonly errorMessage?: string
}

/** Every failing check of a run, for the assertion message. */
async function failures(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const scenario of await readdir(dir)) {
    const checks = JSON.parse(await readFile(join(dir, scenario, 'checks.json'), 'utf8')) as Check[]
    for (const c of checks) {
      if (c.status === 'FAILURE') {
        out.push(`${scenario} ${c.id}: ${(c.errorMessage ?? '').slice(0, 160)}`)
      }
    }
  }
  return out
}

describe('MCP conformance suite', () => {
  for (const revision of ['2026-07-28', '2025-11-25'] as const) {
    it(`meets the ${revision} requirements except the recorded expected failures`, async () => {
      const fixture = await startMcpFixture({ injectToken: true, unlimited: true })
      const output = await mkdtemp(join(tmpdir(), `exdb-conformance-${revision}-`))
      const baseline = fileURLToPath(
        new URL(`./conformance/expected-failures.${revision}.yaml`, import.meta.url),
      )
      try {
        let code = 0
        let stdout = ''
        try {
          const done = await run(
            'bunx',
            [
              SUITE,
              'server',
              '--url',
              fixture.url,
              '--requirements',
              revision,
              '--expected-failures',
              baseline,
              '-o',
              output,
            ],
            { maxBuffer: 64 * 1024 * 1024, timeout: 540_000 },
          )
          stdout = done.stdout
        } catch (error) {
          const e = error as { code?: number; stdout?: string }
          code = typeof e.code === 'number' ? e.code : 1
          stdout = e.stdout ?? ''
        }
        const summary = stdout.slice(stdout.indexOf('=== SUMMARY ==='))
        expect(code, `${summary}\n${(await failures(output)).join('\n')}`).toBe(0)
        // The run really happened: scenarios ran and wrote their checks.
        expect((await readdir(output)).length).toBeGreaterThan(10)
      } finally {
        await fixture.stop()
        await rm(output, { recursive: true, force: true })
      }
    })
  }
})

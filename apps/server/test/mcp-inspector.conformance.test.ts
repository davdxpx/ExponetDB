import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MCP_SERVED_TOOL_LIST, type Scope } from '@exponetdb/contracts'
import { newId } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import { usable } from '../src/interfaces/mcp/registry.ts'
import { startMcpFixture } from './support/mcp-fixture-server.ts'
import { TOKEN } from './support/mcp-world.ts'

/**
 * The MCP Inspector CLI as an external oracle (Wave 7 order §32), pinned,
 * against the test composition of `/mcp` on a real port, in both eras:
 * `tools/list` with `--strict` (schema portability: no error and no
 * warning), a tool call, and a refused token (exit 3, no interactive
 * login in a test). The Inspector negotiates the era itself (`--protocol-era`).
 */
const INSPECTOR = '@modelcontextprotocol/inspector@2.10.1'
const run = promisify(execFile)

/** Every scope an MCP client can hold: the whole served list is checked. */
const EVERY_MCP_SCOPE: Scope[] = [
  'targets.read',
  'schema.read',
  'diagnostics.read',
  'migrations.read',
  'nodes.read',
  'audit.read',
  'migrations.plan',
  'migrations.apply:nonprod',
  'migrations.apply:prod',
  'data.read:nonprod',
  'data.read:prod',
]

async function inspect(
  url: string,
  token: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const done = await run(
      'npx',
      [
        '-y',
        INSPECTOR,
        '--cli',
        url,
        '--header',
        `Authorization: Bearer ${token}`,
        '--stored-auth-only',
        '--format',
        'json',
        ...args,
      ],
      { maxBuffer: 16 * 1024 * 1024, timeout: 240_000 },
    )
    return { code: 0, stdout: done.stdout, stderr: done.stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }
  }
}

describe('MCP Inspector CLI (pinned)', () => {
  for (const era of ['legacy', 'modern'] as const) {
    it(`lists every served tool in the ${era} era with portable schemas (--strict: no finding)`, async () => {
      const fixture = await startMcpFixture({ scopes: EVERY_MCP_SCOPE, unlimited: true })
      try {
        const listed = await inspect(fixture.url, TOKEN, [
          '--method',
          'tools/list',
          '--protocol-era',
          era,
          '--strict',
        ])
        expect(listed.code, listed.stderr.slice(0, 2000)).toBe(0)
        expect(listed.stderr).not.toMatch(/Warning|Error/)
        const tools = (JSON.parse(listed.stdout) as { result: { tools: { name: string }[] } })
          .result.tools
        // The fixture's grant is single-tier (nonprod): what `usable` offers it, nothing else.
        const offered = MCP_SERVED_TOOL_LIST.filter((t) =>
          usable(t, {
            credential: {
              type: 'access_token',
              grantId: newId('grt', 0),
              clientId: newId('cli', 0),
              grantKind: 'delegated',
            },
            resource: 'mcp',
            scopes: new Set(EVERY_MCP_SCOPE),
            restrictions: { targets: { kind: 'all' }, tiers: ['nonprod'] },
          }),
        )
        expect(offered.length).toBeGreaterThanOrEqual(24)
        expect(tools.map((t) => t.name).sort()).toEqual(offered.map((t) => t.name).sort())
        const called = await inspect(fixture.url, TOKEN, [
          '--method',
          'tools/call',
          '--tool-name',
          'targets_list',
          '--protocol-era',
          era,
        ])
        expect(called.code, called.stderr.slice(0, 500)).toBe(0)
        const result = JSON.parse(called.stdout) as {
          result: { structuredContent?: unknown; content: { text: string }[] }
        }
        expect(result.result.structuredContent).toEqual({ items: [], nextCursor: null })
        expect(result.result.content[0]?.text).toContain('never instructions')
      } finally {
        await fixture.stop()
      }
    }, 600_000)
  }

  it('stops at a refused token: exit 3, no tool listed', async () => {
    const fixture = await startMcpFixture({ unlimited: true })
    try {
      const refused = await inspect(fixture.url, 'exat_wrong', [
        '--method',
        'tools/list',
        '--protocol-era',
        'modern',
      ])
      expect(refused.code).toBe(3)
      expect(refused.stdout).not.toContain('"tools"')
    } finally {
      await fixture.stop()
    }
  }, 300_000)
})

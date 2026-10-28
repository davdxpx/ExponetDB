// R2 probe (E9/TC-041): migration lint has no path, bundle or since filter. Copy to apps/cli/test/.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../src/main.ts'
import { testIo } from './support.ts'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'exdb-r2-e9-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const noNetwork: typeof fetch = () => Promise.reject(new Error('no network'))
async function cli(argv: readonly string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await run(argv, testIo({ configDir: join(dir, 'config'), cwd: join(dir, 'repo'), fetch: noNetwork, stdout, stderr }))
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

describe('R2 E9 probe', () => {
  it('an old prod-blocking bundle and a clean new one', async () => {
    await mkdir(join(dir, 'repo'))
    expect((await cli(['init', '--project', 'demo/platform'])).code).toBe(0)
    const oldB = JSON.parse((await cli(['migration', 'new', 'old-definer', '--json'])).stdout)
    await writeFile(join(oldB.data.path, 'up.sql'), 'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;\n')
    const newB = JSON.parse((await cli(['migration', 'new', 'clean-new', '--json'])).stdout)
    await writeFile(join(newB.data.path, 'up.sql'), 'SELECT 1;\n')
    await writeFile(join(newB.data.path, 'verify.sql'), '-- check: ok\nSELECT true AS ok;\n')
    const out: string[] = []
    for (const argv of [
      ['migration', 'lint'],
      ['migration', 'lint', newB.data.path],
      ['migration', 'lint', '--bundle', newB.data.migrationId],
      ['migration', 'lint', '--since', oldB.data.migrationId],
      ['migration', 'lint', '--only', newB.data.migrationId],
      ['migration', 'lint', '--exclude-applied'],
      ['migration', 'lint', '--tier', 'nonprod'],
    ]) {
      const r = await cli(argv)
      out.push(`R2-E9 ${argv.slice(2).join(' ').replace(/[0-9A-Z]{26}/g, '<id>') || '(no argument)'}: exit ${r.code} | ${(r.stdout + r.stderr).split('\n').filter((l) => /error|blocked|usage|unknown|unrecognized|MIGRATION_LINT|skipped|finding/i.test(l)).slice(0, 2).join(' / ').slice(0, 220)}`)
    }
    console.log(out.join('\n'))
    expect(true).toBe(true)
  })
})

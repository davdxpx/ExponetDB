import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The local test lab against the real Docker daemon (order §57, §58;
 * [`15-cli/lab.md`](../../../exponetdb-docs/15-cli/lab.md)): a lab from an
 * ExponetDB image (`EXDB_LAB_IMAGE`, e.g. the image CI just built), its
 * readiness, the smoke suite with run records, the run lock (refused,
 * interrupted, stale), resume after stop, refusal of foreign containers,
 * export without environments, and a destroy that leaves nothing of the
 * lab behind. The CLI runs as a process from source.
 *
 * Never skipped: without Docker or EXDB_LAB_IMAGE the suite fails.
 */
const exec = promisify(execFile)
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const IMAGE = process.env['EXDB_LAB_IMAGE'] ?? ''
const LAB = `t${Date.now().toString(36).slice(-6)}`
let config = ''
let port = 0

interface Out {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function exdb(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Out> {
  try {
    const { stdout, stderr } = await exec(
      'bun',
      ['--conditions=@exponetdb/source', MAIN, ...args],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: config,
          EXPONETDB_CONFIG_DIR: config,
          NO_COLOR: '1',
          ...env,
        },
        maxBuffer: 32 * 1024 * 1024,
        timeout: 600_000,
      },
    )
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }
  }
}

const json = (o: Out) => JSON.parse(o.stdout)

async function docker(args: readonly string[]): Promise<string> {
  return (await exec('docker', ['--host', 'unix:///var/run/docker.sock', ...args])).stdout.trim()
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const address = s.address()
      const p = typeof address === 'object' && address !== null ? address.port : 0
      s.close(() => resolve(p))
    })
  })
}

const labDir = () => join(config, 'labs', LAB)

beforeAll(async () => {
  expect(IMAGE, 'EXDB_LAB_IMAGE names the ExponetDB image the lab runs').not.toBe('')
  config = await realpath(await mkdtemp(join(tmpdir(), 'exdb-lab-test-')))
  port = await freePort()
})

afterAll(async () => {
  // Whatever a failed test left: only this lab's own objects, by label.
  const ids = await docker(['ps', '-aq', '--filter', `label=cloud.exponet.lab.id=${LAB}`]).catch(
    () => '',
  )
  if (ids !== '') await docker(['rm', '-f', ...ids.split('\n')]).catch(() => '')
  const vols = await docker([
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=cloud.exponet.lab.id=${LAB}`,
  ]).catch(() => '')
  if (vols !== '') await docker(['volume', 'rm', ...vols.split('\n')]).catch(() => '')
  await docker(['network', 'rm', `exdb-lab-${LAB}`]).catch(() => '')
  await rm(config, { recursive: true, force: true })
})

describe('the local lab', () => {
  it('comes up ready from an image, with private secrets and no secret in its output', async () => {
    const up = await exdb([
      'dev',
      'up',
      '--lab',
      LAB,
      '--image',
      IMAGE,
      '--port',
      String(port),
      '--json',
    ])
    expect(up.code, up.stderr).toBe(0)
    const s = json(up).data
    expect(s).toMatchObject({
      labId: LAB,
      exists: true,
      ready: true,
      server: `http://localhost:${port}`,
      postgres: 17,
    })
    expect(s.installationId).toMatch(/^ins_[0-9A-Z]{26}$/)
    expect(s.roles.map((r: { role: string; ready: boolean }) => [r.role, r.ready])).toEqual([
      ['control', true],
      ['staging', true],
      ['production', true],
      ['serve', true],
      ['worker', true],
      ['gateway', true],
    ])
    expect((await stat(labDir())).mode & 0o777).toBe(0o700)
    const secrets = join(labDir(), 'secrets')
    expect((await stat(secrets)).mode & 0o777).toBe(0o700)
    for (const f of await readdir(secrets))
      expect((await stat(join(secrets, f))).mode & 0o777, f).toBe(0o600)
    const credentials = await readFile(join(secrets, 'credentials'), 'utf8')
    for (const line of credentials.split('\n').filter((l) => l.includes('='))) {
      const password = line.slice(line.indexOf('=') + 1)
      expect(`${up.stdout}${up.stderr}`).not.toContain(password)
    }
    // Every object carries the lab's labels; nothing is published but serve on loopback.
    const ps = await docker([
      'ps',
      '--filter',
      `label=cloud.exponet.lab.id=${LAB}`,
      '--format',
      '{{.Names}} {{.Ports}}',
    ])
    expect(ps.split('\n')).toHaveLength(6)
    for (const line of ps.split('\n')) {
      if (line.includes('-serve ')) expect(line).toContain(`127.0.0.1:${port}->8080/tcp`)
      else expect(line).not.toMatch(/->/)
    }
  })

  it('passes its smoke suite, each run with its own record and log', async () => {
    const first = await exdb(['dev', 'test', 'smoke', '--lab', LAB, '--json'])
    expect(first.code, first.stdout).toBe(0)
    const run = json(first).data.run
    expect(run).toMatchObject({
      suite: 'smoke',
      state: 'passed',
      exitCode: 0,
      labId: LAB,
      fixture: 1,
    })
    const checks = json(first).data.checks as { check: string; ok: boolean }[]
    expect(checks.filter((c) => !c.ok)).toEqual([])
    expect(checks.map((c) => c.check)).toEqual(
      expect.arrayContaining([
        'staging refuses plaintext',
        'production TLS verify-full',
        'serve logs carry no secret',
      ]),
    )
    const log = await readFile(join(labDir(), 'runs', run.runId, 'output.log'), 'utf8')
    expect(log).toContain('ok   staging TLS verify-full')
    const second = json(await exdb(['dev', 'test', 'smoke', '--lab', LAB, '--json'])).data.run
    expect(second.runId).not.toBe(run.runId)
    const runs = json(await exdb(['dev', 'runs', '--lab', LAB, '--json'])).data.items
    expect(runs.map((r: { runId: string }) => r.runId).slice(0, 2)).toEqual([
      second.runId,
      run.runId,
    ])
  })

  it('refuses stop and a second run while a run holds the lab, interrupts it on request, and clears a stale lock', async () => {
    const holder = spawn('sleep', ['300'], { stdio: 'ignore' })
    const runId = 'run_01M4QZ0000000000000000HOLD'
    const record = {
      schema: 'exponetdb.lab-run/v1',
      runId,
      labId: LAB,
      suite: 'unit',
      source: null,
      image: null,
      fixture: 1,
      startedAt: new Date().toISOString(),
      endedAt: null,
      state: 'running',
      exitCode: null,
      reason: null,
      pid: holder.pid,
      childPid: null,
      log: 'output.log',
    }
    const dir = join(labDir(), 'runs', runId)
    await exec('mkdir', ['-m', '700', dir])
    await writeFile(join(dir, 'record.json'), JSON.stringify(record), { mode: 0o600 })
    await writeFile(join(labDir(), 'run.lock'), `${runId}\n`, { mode: 0o600 })
    const stop = await exdb(['dev', 'stop', '--lab', LAB, '--json'])
    expect(stop.code).toBe(1)
    expect(json(stop).error.code).toBe('lab_busy')
    const busy = await exdb(['dev', 'test', 'smoke', '--lab', LAB, '--json'])
    expect(json(busy).error.code).toBe('lab_busy')
    expect(json(await exdb(['dev', 'status', '--lab', LAB, '--json'])).data.activeRun.runId).toBe(
      runId,
    )
    const interrupted = await exdb(['dev', 'stop', '--lab', LAB, '--interrupt', '--json'])
    expect(interrupted.code, interrupted.stdout).toBe(0)
    expect(json(interrupted).data.interruptedRun).toMatchObject({ runId, state: 'interrupted' })
    expect(holder.killed || holder.exitCode !== null || holder.signalCode !== null).toBe(true)
    // A lock whose process is gone is stale: recorded as interrupted, released.
    const stale = { ...record, runId: 'run_01M4QZ0000000000000000DEAD', pid: 2147483646 }
    const staleDir = join(labDir(), 'runs', stale.runId)
    await exec('mkdir', ['-m', '700', staleDir])
    await writeFile(join(staleDir, 'record.json'), JSON.stringify(stale), { mode: 0o600 })
    await writeFile(join(labDir(), 'run.lock'), `${stale.runId}\n`, { mode: 0o600 })
    const status = json(await exdb(['dev', 'status', '--lab', LAB, '--json']))
    expect(status.data.activeRun).toBeNull()
    expect(JSON.parse(await readFile(join(staleDir, 'record.json'), 'utf8')).state).toBe(
      'interrupted',
    )
  })

  it('starts again after a stop with its data, and reports the state of every role', async () => {
    const before = json(await exdb(['dev', 'status', '--lab', LAB, '--json']))
    expect(before.data.ready).toBe(false)
    expect(new Set(before.data.roles.map((r: { state: string }) => r.state))).toEqual(
      new Set(['exited']),
    )
    const up = await exdb(['dev', 'up', '--lab', LAB, '--json'])
    expect(up.code, up.stderr).toBe(0)
    expect(json(up).data.installationId).toBe(before.data.installationId)
  })

  it('never acts on a container it did not create', async () => {
    const lab = JSON.parse(await readFile(join(labDir(), 'lab.json'), 'utf8'))
    const foreign = await docker([
      'create',
      '--label',
      `cloud.exponet.lab.id=${LAB}`,
      'postgres:17.11@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f',
    ])
    try {
      await writeFile(
        join(labDir(), 'lab.json'),
        JSON.stringify({ ...lab, containers: { ...lab.containers, worker: foreign } }),
        { mode: 0o600 },
      )
      const stop = await exdb(['dev', 'stop', '--lab', LAB, '--json'])
      expect(stop.code).toBe(1)
      expect(json(stop).error.code).toBe('lab_foreign')
      // Every container is checked before any is touched: nothing was stopped.
      expect(await docker(['inspect', '-f', '{{.State.Running}}', lab.containers.serve])).toBe(
        'true',
      )
    } finally {
      await writeFile(join(labDir(), 'lab.json'), JSON.stringify(lab), { mode: 0o600 })
      await docker(['rm', '-f', foreign])
    }
    expect((await exdb(['dev', 'up', '--lab', LAB, '--json'])).code).toBe(0)
    // A same-named object of another origin is not adopted.
    const other = `${LAB}x`
    const squatter = await docker([
      'create',
      '--name',
      `exdb-lab-${other}-control`,
      'postgres:17.11@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f',
    ])
    try {
      const up = await exdb([
        'dev',
        'up',
        '--lab',
        other,
        '--image',
        IMAGE,
        '--port',
        String(await freePort()),
        '--json',
      ])
      expect(up.code).toBe(1)
      expect(json(up).error.code).toBe('lab_foreign')
      expect(await docker(['inspect', '-f', '{{.Id}}', squatter])).toBe(squatter)
    } finally {
      await docker(['rm', '-f', squatter])
      await docker(['network', 'rm', `exdb-lab-${other}`]).catch(() => '')
    }
  })

  it('exports without environments, then destroys every object of the lab and its state', async () => {
    const exported = json(await exdb(['dev', 'export', '--lab', LAB, '--json'])).data
      .directory as string
    const facts = await readFile(join(exported, 'containers.json'), 'utf8')
    expect(facts).not.toMatch(/"Env"|POSTGRES_PASSWORD|EXPONETDB_KEYRING|postgres:\/\//)
    expect((await readdir(join(exported, 'logs'))).sort()).toEqual([
      'control.log',
      'gateway.log',
      'production.log',
      'serve.log',
      'staging.log',
      'worker.log',
    ])
    const refused = await exdb(['dev', 'destroy', '--lab', LAB, '--no-input', '--json'])
    expect(refused.code).toBe(2)
    const destroyed = await exdb(['dev', 'destroy', '--lab', LAB, '--yes', '--json'])
    expect(destroyed.code, destroyed.stdout).toBe(0)
    expect(await docker(['ps', '-aq', '--filter', `label=cloud.exponet.lab.id=${LAB}`])).toBe('')
    expect(
      await docker(['volume', 'ls', '-q', '--filter', `label=cloud.exponet.lab.id=${LAB}`]),
    ).toBe('')
    await expect(docker(['network', 'inspect', `exdb-lab-${LAB}`])).rejects.toThrow()
    await expect(stat(labDir())).rejects.toThrow()
    await expect(stat(json(destroyed).data.export)).resolves.toBeDefined()
    expect(json(await exdb(['dev', 'status', '--lab', LAB, '--json'])).error.code).toBe(
      'lab_not_found',
    )
  })

  it('refuses a Docker that is not the local socket, and reports an unreachable daemon as unavailable', async () => {
    const remote = await exdb(['dev', 'status', '--lab', LAB, '--json'], {
      EXPONETDB_LAB_DOCKER_SOCKET: 'tcp://10.0.0.1:2375',
    })
    expect(remote.code).toBe(2)
    const gone = await exdb(['dev', 'status', '--lab', LAB, '--json'], {
      EXPONETDB_LAB_DOCKER_SOCKET: 'unix:///nonexistent/docker.sock',
    })
    expect(gone.code).toBe(5)
    expect(json(gone).error.code).toBe('lab_unavailable')
  })
})

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { newUlid } from '@exponetdb/kernel'
import { CliError } from '../errors.ts'
import { ensurePrivateDir, readPrivateJson, writePrivateJson } from '../files.ts'
import type { Major } from '../local/grammar.ts'

/**
 * The lab's own state ([`15-cli/lab.md`](../../../../exponetdb-docs/15-cli/lab.md)):
 * one private directory per lab ID below the CLI's configuration directory
 * (never inside a repository), with the lab record, the generated secrets,
 * the targets' CA certificates and one directory per test run.
 *
 * Every Docker object of a lab carries its labels: the fixture version, the
 * lab ID, the role and an owner tag derived from this state directory. A
 * mutation acts on the container IDs recorded here, after checking those
 * labels; an object without them is never adopted.
 */
export const LAB_SCHEMA = 'exponetdb.lab/v1'
export const RUN_SCHEMA = 'exponetdb.lab-run/v1'
/** The fixture: images, roles and their configuration. A change is a new version. */
export const FIXTURE_VERSION = 1

export const IMAGES = {
  control: 'postgres:17.11@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f',
  target: {
    16: 'pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a',
    17: 'pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d',
    18: 'pgvector/pgvector:pg18@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11',
  } satisfies Record<Major, string>,
} as const

export const DATABASE_ROLES = ['control', 'staging', 'production'] as const
export const PROCESS_ROLES = ['serve', 'worker', 'gateway'] as const
export type DatabaseRole = (typeof DATABASE_ROLES)[number]
export type ProcessRole = (typeof PROCESS_ROLES)[number]
export type Role = DatabaseRole | ProcessRole
export const ROLES: readonly Role[] = [...DATABASE_ROLES, ...PROCESS_ROLES]

const LAB_ID = /^[a-z][a-z0-9-]{0,22}[a-z0-9]$|^[a-z]$/

export function checkLabId(id: string): string {
  if (!LAB_ID.test(id)) {
    throw new CliError(
      'usage',
      'A lab ID is 1 to 24 lowercase letters, digits or dashes, starting with a letter.',
    )
  }
  return id
}

export interface LabPaths {
  readonly root: string
  readonly record: string
  readonly secrets: string
  readonly tls: string
  readonly runs: string
  readonly lock: string
  readonly work: string
  readonly exports: string
}

export function labPaths(configDir: string, labId: string): LabPaths {
  const root = join(configDir, 'labs', labId)
  return {
    root,
    record: join(root, 'lab.json'),
    secrets: join(root, 'secrets'),
    tls: join(root, 'tls'),
    runs: join(root, 'runs'),
    lock: join(root, 'run.lock'),
    work: join(root, 'work'),
    exports: join(configDir, 'lab-exports'),
  }
}

/** Ties Docker objects to this state directory (a hash, no path on the label). */
export function ownerTag(paths: LabPaths): string {
  return createHash('sha256').update(paths.root).digest('hex').slice(0, 16)
}

export const LABEL = {
  fixture: 'cloud.exponet.lab.fixture',
  id: 'cloud.exponet.lab.id',
  role: 'cloud.exponet.lab.role',
  owner: 'cloud.exponet.lab.owner',
} as const

export function labelArgs(labId: string, role: string, owner: string): string[] {
  return [
    '--label',
    `${LABEL.fixture}=${FIXTURE_VERSION}`,
    '--label',
    `${LABEL.id}=${labId}`,
    '--label',
    `${LABEL.role}=${role}`,
    '--label',
    `${LABEL.owner}=${owner}`,
  ]
}

export const containerName = (labId: string, role: Role): string => `exdb-lab-${labId}-${role}`
/**
 * A target's DNS name on the lab network (a network alias under the
 * reserved `.test` domain): registration takes a dotted DNS name, and the
 * target's certificate is issued for it.
 */
export const targetHost = (labId: string, role: 'staging' | 'production'): string =>
  `${role}.${labId}.exdb-lab.test`
export const volumeName = (labId: string, role: DatabaseRole): string =>
  `exdb-lab-${labId}-${role}-data`
export const networkName = (labId: string): string => `exdb-lab-${labId}`

export interface LabRecord {
  readonly schema: typeof LAB_SCHEMA
  readonly labId: string
  readonly fixture: number
  readonly createdAt: string
  readonly postgres: Major
  readonly port: number
  readonly source: { readonly dir: string; readonly commit: string } | null
  readonly image: { readonly ref: string; readonly id: string; readonly revision: string | null }
  readonly network: { readonly name: string; readonly id: string }
  readonly containers: Readonly<Partial<Record<Role, string>>>
  readonly volumes: Readonly<Partial<Record<DatabaseRole, string>>>
  readonly installationId: string | null
}

export async function readLab(paths: LabPaths): Promise<LabRecord | undefined> {
  const value = (await readPrivateJson(paths.record)) as LabRecord | undefined
  if (value === undefined) return undefined
  if (value.schema !== LAB_SCHEMA || value.fixture !== FIXTURE_VERSION) {
    throw new CliError(
      'lab_failed',
      `${paths.record} is from another lab version; destroy the lab with that CLI, or remove the containers labeled ${LABEL.id}=${value.labId} yourself.`,
    )
  }
  return value
}

export async function writeLab(paths: LabPaths, lab: LabRecord): Promise<void> {
  await writePrivateJson(paths.record, lab)
}

export async function prepareDirs(paths: LabPaths): Promise<void> {
  for (const dir of [paths.root, paths.secrets, paths.tls, paths.runs, paths.work]) {
    await ensurePrivateDir(dir)
  }
}

// ----- test runs -----

export type RunState = 'running' | 'passed' | 'failed' | 'interrupted' | 'lab_unavailable'

export interface RunRecord {
  readonly schema: typeof RUN_SCHEMA
  readonly runId: string
  readonly labId: string
  readonly suite: string
  readonly source: { readonly commit: string } | null
  readonly image: LabRecord['image'] | null
  readonly fixture: number
  readonly startedAt: string
  readonly endedAt: string | null
  readonly state: RunState
  readonly exitCode: number | null
  readonly reason: string | null
  readonly pid: number
  readonly childPid: number | null
  /** The run's own output, relative to its directory. */
  readonly log: 'output.log'
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

export const runDir = (paths: LabPaths, runId: string): string => join(paths.runs, runId)

export async function readRun(paths: LabPaths, runId: string): Promise<RunRecord | undefined> {
  return (await readPrivateJson(join(runDir(paths, runId), 'record.json'))) as RunRecord | undefined
}

export async function writeRun(paths: LabPaths, run: RunRecord): Promise<void> {
  await writePrivateJson(join(runDir(paths, run.runId), 'record.json'), run)
}

/** Every recorded run, newest first. */
export async function listRuns(paths: LabPaths): Promise<RunRecord[]> {
  const names = await readdir(paths.runs).catch(() => [] as string[])
  const runs: RunRecord[] = []
  for (const name of names) {
    if (!name.startsWith('run_')) continue
    const run = await readRun(paths, name).catch(() => undefined)
    if (run !== undefined) runs.push(run)
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/**
 * The run holding the lab, if any. A lock whose process is gone is stale:
 * its run is recorded as interrupted and the lock removed.
 */
export async function activeRun(paths: LabPaths, now: number): Promise<RunRecord | undefined> {
  let text: string
  try {
    text = await readFile(paths.lock, 'utf8')
  } catch {
    return undefined
  }
  const runId = text.trim()
  const run = /^run_[0-9A-Z]{26}$/.test(runId) ? await readRun(paths, runId) : undefined
  if (run !== undefined && run.state === 'running' && alive(run.pid)) return run
  if (run !== undefined && run.state === 'running') {
    await writeRun(paths, {
      ...run,
      state: 'interrupted',
      endedAt: new Date(now).toISOString(),
      reason: 'the process running it ended without recording an outcome',
    })
  }
  await rm(paths.lock, { force: true })
  return undefined
}

/** Starts a run: takes the lock (one mutating run per lab) and records it as running. */
export async function startRun(
  paths: LabPaths,
  base: Omit<
    RunRecord,
    | 'schema'
    | 'runId'
    | 'startedAt'
    | 'endedAt'
    | 'state'
    | 'exitCode'
    | 'reason'
    | 'log'
    | 'childPid'
  >,
  now: number,
): Promise<RunRecord> {
  const busy = await activeRun(paths, now)
  if (busy !== undefined) {
    throw new CliError(
      'lab_busy',
      `Run ${busy.runId} (${busy.suite}) holds lab ${busy.labId}; wait for it, or stop it with: exponetdb dev stop --lab ${busy.labId} --interrupt`,
    )
  }
  const run: RunRecord = {
    schema: RUN_SCHEMA,
    runId: `run_${newUlid(now)}`,
    startedAt: new Date(now).toISOString(),
    endedAt: null,
    state: 'running',
    exitCode: null,
    reason: null,
    childPid: null,
    log: 'output.log',
    ...base,
  }
  await ensurePrivateDir(runDir(paths, run.runId))
  await writeRun(paths, run)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      paths.lock,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
  } catch {
    await writeRun(paths, {
      ...run,
      state: 'interrupted',
      endedAt: run.startedAt,
      reason: 'another run took the lab first',
    })
    throw new CliError(
      'lab_busy',
      `Another run took lab ${run.labId} at the same moment; try again.`,
    )
  }
  try {
    await handle.writeFile(`${run.runId}\n`)
  } finally {
    await handle.close()
  }
  return run
}

/** Ends a run with its outcome and releases the lock. */
export async function finishRun(
  paths: LabPaths,
  run: RunRecord,
  outcome: { state: Exclude<RunState, 'running'>; exitCode: number | null; reason?: string },
  now: number,
): Promise<RunRecord> {
  const done: RunRecord = {
    ...run,
    state: outcome.state,
    exitCode: outcome.exitCode,
    reason: outcome.reason ?? null,
    endedAt: new Date(now).toISOString(),
  }
  await writeRun(paths, done)
  const held = await readFile(paths.lock, 'utf8').catch(() => '')
  if (held.trim() === run.runId) await rm(paths.lock, { force: true })
  return done
}

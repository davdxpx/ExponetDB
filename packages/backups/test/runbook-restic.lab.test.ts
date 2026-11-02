import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateRunbook } from '../src/runbook.ts'

/**
 * VC-059 (TC-045 / D-07): the generated restic runbook restored a logical snapshot whose dump
 * grants to a role without creating the role: `pg_restore --exit-on-error` stopped at the GRANT
 * and left a running, half-restored cluster; a snapshot without a globals file was not noticed.
 * Here a PostgreSQL 17 source is dumped as the node does (`pg_dump -Fc` per database and
 * `pg_dumpall --globals-only --no-role-passwords`) into a local restic repository, and the runbook
 * restores it with no ExponetDB process. Needs root, restic and PostgreSQL 17 (`vitest.lab.config.ts`).
 */
const PG = '/usr/lib/postgresql/17/bin'
const available =
  process.getuid?.() === 0 && existsSync(`${PG}/initdb`) && existsSync('/usr/bin/restic')

const lab = mkdtempSync('/var/tmp/exdb-restic-lab-')
const asPostgres = (cmd: string, args: readonly string[], env: Record<string, string> = {}) =>
  spawnSync(
    'runuser',
    [
      '-u',
      'postgres',
      '--',
      'env',
      ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      cmd,
      ...args,
    ],
    { encoding: 'utf8', cwd: lab },
  )

const source = join(lab, 'source')
const repo = join(lab, 'repo')
const passFile = join(lab, 'restic-pass')
const port = 55481
const ROWS = 321

/**
 * The node's dump directory of one snapshot: the databases and, unless `globals` is false, the
 * roles; `extra` adds files (a damaged dump, a crafted globals file).
 */
function snapshot(name: string, globals: boolean, extra: Record<string, string> = {}): string {
  const dir = join(lab, name)
  mkdirSync(dir)
  execFileSync('chown', ['postgres', dir])
  const conn = ['-h', lab, '-p', String(port)]
  expect(
    asPostgres(`${PG}/pg_dump`, [...conn, '-Fc', '-d', 'tiny', `--file=${join(dir, 'tiny.dump')}`])
      .status,
  ).toBe(0)
  if (globals) {
    const g = asPostgres(`${PG}/pg_dumpall`, [
      ...conn,
      '--globals-only',
      '--no-role-passwords',
      `--file=${join(dir, 'globals.sql')}`,
    ])
    expect(g.status, g.stderr).toBe(0)
  }
  for (const [file, text] of Object.entries(extra)) {
    writeFileSync(join(dir, file), text)
    execFileSync('chown', ['postgres', join(dir, file)])
  }
  const b = asPostgres('restic', ['backup', '--tag', 'exponetdb', '--json', dir], {
    RESTIC_REPOSITORY: repo,
    RESTIC_PASSWORD_FILE: passFile,
  })
  expect(b.status, b.stderr).toBe(0)
  const summary = b.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('"summary"'))
    .at(-1)
  return String(JSON.parse(summary ?? '{}').snapshot_id)
}

let withGlobals = ''
let withoutGlobals = ''
let damagedSecondDump = ''
let shellEscape = ''

beforeAll(() => {
  if (!available) {
    throw new Error(
      'the restic runbook lab test needs root, /usr/bin/restic and PostgreSQL 17 (it is never skipped)',
    )
  }
  execFileSync('chown', ['postgres', lab])
  chmodSync(lab, 0o755)
  writeFileSync(passFile, randomBytes(24).toString('base64url'))
  chownSync(passFile, Number(execFileSync('id', ['-u', 'postgres']).toString()), 0)
  chmodSync(passFile, 0o600)
  expect(
    asPostgres('restic', ['init'], { RESTIC_REPOSITORY: repo, RESTIC_PASSWORD_FILE: passFile })
      .status,
  ).toBe(0)
  expect(asPostgres(`${PG}/initdb`, ['-D', source, '--auth=peer']).status).toBe(0)
  expect(
    asPostgres(`${PG}/pg_ctl`, [
      '-D',
      source,
      '-l',
      join(lab, 'source.log'),
      '-o',
      `-c port=${port} -c listen_addresses= -c unix_socket_directories=${lab}`,
      '-w',
      'start',
    ]).status,
  ).toBe(0)
  const psql = (db: string, sql: string) =>
    asPostgres(`${PG}/psql`, [
      '-h',
      lab,
      '-p',
      String(port),
      '-d',
      db,
      '-v',
      'ON_ERROR_STOP=1',
      '-Atc',
      sql,
    ])
  expect(psql('postgres', 'CREATE ROLE s2_owner; CREATE ROLE s2_reader').status).toBe(0)
  expect(psql('postgres', 'CREATE DATABASE tiny OWNER s2_owner').status).toBe(0)
  const made = psql(
    'tiny',
    `CREATE TABLE public.t AS SELECT g AS id FROM generate_series(1, ${ROWS}) g; GRANT SELECT ON TABLE public.t TO s2_reader`,
  )
  expect(made.status, made.stderr).toBe(0)
  withGlobals = snapshot('dump-with-globals', true)
  withoutGlobals = snapshot('dump-without-globals', false)
  // VC-059 review: a second dump that cannot be read, and a globals file that runs a shell command.
  damagedSecondDump = snapshot('dump-damaged', true, { 'zz.dump': 'not a dump' })
  shellEscape = snapshot('dump-shell', false, {
    'globals.sql': `\\! touch ${join(lab, 'escaped')}\nCREATE ROLE s2_owner;\n`,
  })
}, 300_000)

afterAll(() => {
  if (!available) return
  for (const dir of [
    source,
    join(lab, 'restored-ok'),
    join(lab, 'restored-none'),
    join(lab, 'restored-bad'),
    join(lab, 'restored-damaged'),
    join(lab, 'restored-shell'),
  ]) {
    if (existsSync(join(dir, 'postmaster.pid')))
      asPostgres(`${PG}/pg_ctl`, ['-D', dir, '-m', 'immediate', 'stop'])
  }
  rmSync(lab, { recursive: true, force: true })
})

function runbook(): string {
  const { script } = generateRunbook({
    repositoryId: 'bkr_01M60000000000000000000011',
    revision: 1,
    clusterId: 'cls_01M60000000000000000000012',
    engine: 'restic',
    provider: 'posix',
    endpointHost: null,
    region: null,
    bucket: null,
    prefix: repo.slice(1),
    stanza: null,
    repoIndex: null,
    cipher: 'restic',
    pinnedEngineVersion: null,
    postgresMajor: 17,
  })
  const file = join(lab, 'runbook-restic.sh')
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  return file
}

const restore = (target: string, restoredPort: number, env: Record<string, string>) =>
  asPostgres('sh', [runbook()], {
    TARGET_DIR: join(lab, target),
    PG_BIN: PG,
    PORT: String(restoredPort),
    RESTIC_PASSWORD_FILE: passFile,
    ...env,
  })

const running = (target: string) =>
  asPostgres(`${PG}/pg_ctl`, ['-D', join(lab, target), 'status']).status === 0

describe('the generated restic runbook restores a logical snapshot with its roles (lab, VC-059)', () => {
  it('creates the roles first: the dump with a role grant restores, ok', () => {
    const run = restore('restored-ok', 55482, { SNAPSHOT: withGlobals })
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
    const q = (sql: string) =>
      asPostgres(`${PG}/psql`, [
        '-h',
        join(lab, 'restored-ok.exponetdb', 'socket'),
        '-p',
        '55482',
        '-d',
        'tiny',
        '-Atc',
        sql,
      ]).stdout.trim()
    expect(q('SELECT count(*) FROM public.t')).toBe(String(ROWS))
    expect(
      q(`SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 's2_%'`),
    ).toBe('s2_owner,s2_reader')
    expect(q(`SELECT has_table_privilege('s2_reader', 'public.t', 'SELECT')`)).toBe('t')
  }, 300_000)

  it('stops before anything is created when the snapshot holds no globals file, with a named message', () => {
    const run = restore('restored-none', 55483, { SNAPSHOT: withoutGlobals })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('no globals')
    expect(existsSync(join(lab, 'restored-none', 'PG_VERSION'))).toBe(false)
  }, 300_000)

  it('reads every dump before anything is created: a damaged second dump restores nothing (review)', () => {
    const run = restore('restored-damaged', 55485, { SNAPSHOT: damagedSecondDump })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('unreadable dump')
    expect(existsSync(join(lab, 'restored-damaged', 'PG_VERSION'))).toBe(false)
  }, 300_000)

  it('refuses a globals file with a psql shell escape (review)', () => {
    const run = restore('restored-shell', 55486, { SNAPSHOT: shellEscape })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('meta-command')
    expect(existsSync(join(lab, 'escaped'))).toBe(false)
    expect(existsSync(join(lab, 'restored-shell', 'PG_VERSION'))).toBe(false)
  }, 300_000)

  it('never leaves a half-restored cluster running when pg_restore fails', () => {
    // The roles file the operator names lacks the reader: the GRANT fails.
    const partial = join(lab, 'globals-partial.sql')
    writeFileSync(partial, 'CREATE ROLE s2_owner;\n')
    execFileSync('chown', ['postgres', partial])
    const run = restore('restored-bad', 55484, { SNAPSHOT: withoutGlobals, GLOBALS_FILE: partial })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('pg_restore failed')
    expect(running('restored-bad')).toBe(false)
  }, 300_000)
})

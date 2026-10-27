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
 * A local rehearsal of the C-35 drill on a disposable lab: a PostgreSQL 17
 * cluster archives into an encrypted pgBackRest repository on a local
 * directory (posix), a full backup is taken, then the generated runbook,
 * with no ExponetDB process involved, restores it into a new directory and
 * starts it on a localhost port. Needs root, pgBackRest and PostgreSQL 17
 * binaries on the machine (`vitest.lab.config.ts`). It proves the script
 * works against a real engine; it is not the owner's C-35 drill (offline
 * keys, real storage, Control Plane stopped on the installation).
 */
const PG = '/usr/lib/postgresql/17/bin'
const available =
  process.getuid?.() === 0 && existsSync(`${PG}/initdb`) && existsSync('/usr/bin/pgbackrest')

const lab = mkdtempSync('/var/tmp/exdb-runbook-lab-')
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
    {
      encoding: 'utf8',
      cwd: lab,
    },
  )

const data = join(lab, 'source')
const repo = join(lab, 'repo')
const conf = join(lab, 'pgbackrest.conf')
const passFile = join(lab, 'cipher-pass')
const restored = join(lab, 'restored')
const port = 55471
const restoredPort = 55472

beforeAll(() => {
  if (!available) {
    throw new Error(
      'the runbook lab test needs root, /usr/bin/pgbackrest and PostgreSQL 17 under /usr/lib/postgresql/17 (it is never skipped)',
    )
  }
  execFileSync('chown', ['postgres', lab])
  chmodSync(lab, 0o755)
  const pass = randomBytes(24).toString('base64url')
  writeFileSync(passFile, pass)
  chownSync(passFile, Number(execFileSync('id', ['-u', 'postgres']).toString()), 0)
  chmodSync(passFile, 0o600)
  mkdirSync(repo)
  execFileSync('chown', ['postgres', repo])
  writeFileSync(
    conf,
    `[global]\nrepo1-path=${repo}\nrepo1-cipher-type=aes-256-cbc\nrepo1-cipher-pass=${pass}\nlog-path=${lab}\nlock-path=${lab}\n[main]\npg1-path=${data}\npg1-port=${port}\npg1-socket-path=${lab}\n`,
  )
  execFileSync('chown', ['postgres', conf])
  chmodSync(conf, 0o600)
  expect(asPostgres(`${PG}/initdb`, ['-D', data, '--auth=peer']).status).toBe(0)
  writeFileSync(
    join(data, 'postgresql.auto.conf'),
    `port = ${port}\nlisten_addresses = ''\nunix_socket_directories = '${lab}'\narchive_mode = on\narchive_command = 'pgbackrest --config=${conf} --stanza=main archive-push %p'\nwal_level = replica\n`,
  )
  expect(
    asPostgres(`${PG}/pg_ctl`, ['-D', data, '-l', join(lab, 'source.log'), '-w', 'start']).status,
  ).toBe(0)
  const psql = (sql: string) =>
    asPostgres(`${PG}/psql`, ['-h', lab, '-p', String(port), '-d', 'postgres', '-Atc', sql])
  expect(
    psql('CREATE TABLE drill_rows AS SELECT g AS id FROM generate_series(1, 1234) g').status,
  ).toBe(0)
  expect(
    asPostgres('pgbackrest', [`--config=${conf}`, '--stanza=main', 'stanza-create']).status,
  ).toBe(0)
  const backup = asPostgres('pgbackrest', [
    `--config=${conf}`,
    '--stanza=main',
    '--type=full',
    'backup',
  ])
  expect(backup.status, backup.stderr).toBe(0)
}, 300_000)

afterAll(() => {
  if (!available) return
  for (const dir of [restored, data]) {
    if (existsSync(join(dir, 'postmaster.pid'))) {
      asPostgres(`${PG}/pg_ctl`, ['-D', dir, '-m', 'immediate', 'stop'])
    }
  }
  rmSync(lab, { recursive: true, force: true })
})

describe('the generated runbook restores a real pgBackRest repository (lab)', () => {
  it('restores into a new directory with the offline passphrase file, without ExponetDB', () => {
    const { script } = generateRunbook({
      repositoryId: 'bkr_01M60000000000000000000001',
      revision: 1,
      clusterId: 'cls_01M60000000000000000000002',
      engine: 'pgbackrest',
      provider: 'posix',
      endpointHost: null,
      region: null,
      bucket: null,
      prefix: repo.slice(1),
      stanza: 'main',
      repoIndex: 1,
      cipher: 'aes-256-cbc',
      pinnedEngineVersion: '2.60.0',
      postgresMajor: 17,
    })
    const file = join(lab, 'runbook.sh')
    writeFileSync(file, script)
    chmodSync(file, 0o755)
    const run = asPostgres('sh', [file], {
      TARGET_DIR: restored,
      PG_BIN: PG,
      PORT: String(restoredPort),
      CIPHER_PASS_FILE: passFile,
    })
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
    const count = asPostgres(`${PG}/psql`, [
      '-h',
      join(restored, 'exponetdb-socket'),
      '-p',
      String(restoredPort),
      '-d',
      'postgres',
      '-Atc',
      'SELECT count(*) FROM drill_rows',
    ])
    expect(count.stdout.trim()).toBe('1234')
  }, 300_000)

  it('refuses to restore over a non-empty directory', () => {
    const file = join(lab, 'runbook.sh')
    const again = asPostgres('sh', [file], {
      TARGET_DIR: restored,
      PG_BIN: PG,
      CIPHER_PASS_FILE: passFile,
    })
    expect(again.status).not.toBe(0)
    expect(again.stderr).toContain('refusing to restore over it')
  })

  it('fails without the offline passphrase', () => {
    const file = join(lab, 'runbook.sh')
    const run = asPostgres('sh', [file], { TARGET_DIR: join(lab, 'other'), PG_BIN: PG })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('set CIPHER_PASS_FILE')
  })
})

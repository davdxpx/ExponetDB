import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateRunbook, RunbookRefused, type RunbookRepository } from '../src/runbook.ts'

const r2: RunbookRepository = {
  repositoryId: 'bkr_01M60000000000000000000001',
  revision: 3,
  clusterId: 'cls_01M60000000000000000000002',
  engine: 'pgbackrest',
  provider: 'cloudflare_r2',
  endpointHost: 'abc123.eu.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'exdb-backups',
  prefix: 'pgbackrest/main',
  stanza: 'main',
  repoIndex: 1,
  cipher: 'aes-256-cbc',
  pinnedEngineVersion: '2.60.0',
  postgresMajor: 17,
}

function syntaxOk(script: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'exdb-runbook-'))
  const file = join(dir, 'runbook.sh')
  writeFileSync(file, script)
  return spawnSync('sh', ['-n', file]).status === 0
}

describe('the offline restore runbook (C-35, ADR-0038 §6)', () => {
  it('is deterministic for one record revision and changes with the revision', () => {
    const a = generateRunbook(r2)
    expect(generateRunbook(r2)).toEqual(a)
    expect(generateRunbook({ ...r2, revision: 4 }).digest).not.toBe(a.digest)
    expect(a.filename).toBe('exponetdb-restore-bkr_01m60000000000000000000001.sh')
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('names the record and reads every secret from operator files, never holding one', () => {
    const { script, placeholders } = generateRunbook(r2)
    expect(script).toContain("repo1-s3-endpoint=%s\\n' 'abc123.eu.r2.cloudflarestorage.com'")
    expect(script).toContain('--stanza=main --repo=1')
    expect(script).toContain('PGBACKREST_REPO1_CIPHER_PASS="$(cat "$CIPHER_PASS_FILE")"')
    expect(script).toContain('PGBACKREST_REPO1_S3_KEY_SECRET="$(cat "$S3_SECRET_FILE")"')
    expect(script).not.toMatch(/cipher-pass=|s3-key=|s3-key-secret=|exponet\.cloud|https:\/\/db\./)
    expect(placeholders.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        'TARGET_DIR',
        'PG_BIN',
        'CIPHER_PASS_FILE',
        'S3_KEY_FILE',
        'S3_SECRET_FILE',
      ]),
    )
  })

  it('refuses a non-empty destination and keeps the restored cluster on localhost', () => {
    const { script } = generateRunbook(r2)
    expect(script).toContain('exists and is not empty: refusing to restore over it')
    expect(script).toContain("listen_addresses = 'localhost'")
    expect(script).toContain('archive_mode = off')
    expect(script).toContain(
      '--type="$RESTORE_TYPE" --target="$RESTORE_TARGET" --target-action=promote',
    )
  })

  it('is valid POSIX shell for every engine and provider', () => {
    for (const repo of [
      r2,
      {
        ...r2,
        provider: 'posix',
        endpointHost: null,
        bucket: null,
        region: null,
        prefix: 'var/lib/pgbackrest',
      },
      { ...r2, cipher: 'none' as const },
      {
        ...r2,
        engine: 'restic' as const,
        stanza: null,
        repoIndex: null,
        cipher: 'restic' as const,
      },
      {
        ...r2,
        engine: 'restic' as const,
        provider: 'posix',
        endpointHost: null,
        bucket: null,
        region: null,
        stanza: null,
        repoIndex: null,
        cipher: 'restic' as const,
      },
    ]) {
      expect(syntaxOk(generateRunbook(repo).script), `${repo.engine}/${repo.provider}`).toBe(true)
    }
  })

  it('refuses a value that is not safe to write into shell instead of escaping it', () => {
    for (const bad of [
      { stanza: "main'; rm -rf / #" },
      { prefix: '../../etc' },
      { endpointHost: 'evil.example.com$(id)' },
      { bucket: 'Bad Bucket' },
      { repoIndex: 7 },
      { pinnedEngineVersion: '2.60.0; curl x' },
      { repositoryId: 'bkr_../x' },
    ]) {
      expect(() => generateRunbook({ ...r2, ...bad } as RunbookRepository)).toThrow(RunbookRefused)
    }
  })

  it('refuses a TARGET_DIR with characters outside the safe set before anything runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exdb-runbook-'))
    const file = join(dir, 'runbook.sh')
    writeFileSync(file, generateRunbook(r2).script)
    const run = spawnSync('sh', [file], {
      env: { PATH: '/usr/bin:/bin', TARGET_DIR: "/tmp/x'y", PG_BIN: '/nonexistent' },
      encoding: 'utf8',
    })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('TARGET_DIR may hold only')
    const missing = spawnSync('sh', [file], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('set TARGET_DIR')
  })
})

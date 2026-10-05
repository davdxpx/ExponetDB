import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectOk, parseId } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AUDIT_RETENTION_MIN_DAYS,
  type CheckpointDocument,
  CheckpointExportError,
  checkpointBytes,
  checkpointKey,
  createPseudonymizer,
  fileCheckpointExporter,
  parseAuditRetention,
  s3CheckpointExporter,
  signS3Request,
} from '../src/index.ts'

const installationId = expectOk(
  parseId('ins', 'ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'),
  'fixture installation id',
)

const document = (seq: number, hash = `sha256:ac1:${'a'.repeat(64)}`): CheckpointDocument => ({
  format: 'exponetdb.audit-checkpoint/v1',
  installationId,
  seq,
  hash,
  createdAt: '2026-10-05T12:00:00.000001Z',
})

describe('keyed pseudonyms', () => {
  const key = new Uint8Array(32).fill(7)

  it('are deterministic HMAC-SHA-256 values with a visible scheme', () => {
    const p = createPseudonymizer(key)
    const a = p.pseudonym('ip', '192.0.2.1')
    expect(a).toMatch(/^hmac-sha256:[0-9a-f]{64}$/)
    expect(p.pseudonym('ip', '192.0.2.1')).toBe(a)
    expect(p.pseudonym('ip', '192.0.2.2')).not.toBe(a)
  })

  it('separate kinds and keys', () => {
    const p = createPseudonymizer(key)
    expect(p.pseudonym('user_agent', '192.0.2.1')).not.toBe(p.pseudonym('ip', '192.0.2.1'))
    const other = createPseudonymizer(new Uint8Array(32).fill(8))
    expect(other.pseudonym('ip', '192.0.2.1')).not.toBe(p.pseudonym('ip', '192.0.2.1'))
  })

  it('never contain the input and refuse a key that is not 32 bytes', () => {
    const p = createPseudonymizer(key)
    expect(p.pseudonym('ip', '192.0.2.1')).not.toContain('192')
    expect(() => createPseudonymizer(new Uint8Array(16))).toThrow()
  })

  it('do not change when the caller mutates its key buffer afterwards', () => {
    const k = new Uint8Array(32).fill(9)
    const p = createPseudonymizer(k)
    const before = p.pseudonym('ip', '198.51.100.7')
    k.fill(0)
    expect(p.pseudonym('ip', '198.51.100.7')).toBe(before)
  })
})

describe('audit retention setting', () => {
  it('is permanent or a whole number of days from 400', () => {
    expect(parseAuditRetention('permanent')).toEqual({ kind: 'permanent' })
    expect(parseAuditRetention(AUDIT_RETENTION_MIN_DAYS)).toEqual({ kind: 'days', days: 400 })
    expect(parseAuditRetention(3650)).toEqual({ kind: 'days', days: 3650 })
  })

  it('refuses anything shorter, fractional, unbounded or of another type', () => {
    for (const value of [399, 0, -1, 400.5, 36_501, '400', null, {}, [], true, 'PERMANENT']) {
      expect(parseAuditRetention(value), JSON.stringify(value)).toBeUndefined()
    }
  })
})

describe('checkpoint documents', () => {
  it('are canonical JSON with a trailing newline and a sortable key', () => {
    const text = new TextDecoder().decode(checkpointBytes(document(42)))
    expect(text).toBe(
      `{"createdAt":"2026-10-05T12:00:00.000001Z","format":"exponetdb.audit-checkpoint/v1","hash":"sha256:ac1:${'a'.repeat(64)}","installationId":"ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z","seq":42}\n`,
    )
    expect(checkpointKey(document(42))).toBe(
      'ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/audit-checkpoints/00000000000000000042.json',
    )
    expect(checkpointKey(document(7), 'exponetdb/')).toBe(
      'exponetdb/ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/audit-checkpoints/00000000000000000007.json',
    )
  })

  it('carry only an HTTP or file-system code in export errors', () => {
    expect(new CheckpointExportError('http_403').detailCode).toBe('http_403')
    expect(new CheckpointExportError('secret=abc; body').detailCode).toBe('unknown')
  })
})

describe('file checkpoint sink', () => {
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'exdb-checkpoints-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes one 0600 file per checkpoint and accepts an identical rerun', async () => {
    const sink = fileCheckpointExporter(dir)
    const result = await sink.export(document(1))
    expect(result.location).toBe(`file:${checkpointKey(document(1))}`)
    const path = join(dir, checkpointKey(document(1)))
    expect(new Uint8Array(await readFile(path))).toEqual(checkpointBytes(document(1)))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(sink.export(document(1))).resolves.toEqual(result)
  })

  it('never overwrites a different checkpoint under the same key', async () => {
    const sink = fileCheckpointExporter(dir)
    await sink.export(document(2))
    await expect(sink.export(document(2, `sha256:ac1:${'b'.repeat(64)}`))).rejects.toMatchObject({
      code: 'audit_export_failed',
      detailCode: 'conflict',
    })
  })

  it('reports an unwritable directory as an export failure', async () => {
    const file = join(dir, 'not-a-directory')
    await writeFile(file, 'x')
    await expect(fileCheckpointExporter(file).export(document(3))).rejects.toBeInstanceOf(
      CheckpointExportError,
    )
  })
})

describe('S3 Signature Version 4', () => {
  it('reproduces the published "GET Object" example of the S3 SigV4 documentation', () => {
    // AWS S3 API reference, "Signature Calculations for the Authorization
    // Header", example GET Object. The example key id is published by AWS;
    // it is assembled here so the secret scanner's AWS-key rule stays strict.
    const exampleKeyId = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
    const signed = signS3Request({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payload: new Uint8Array(),
      region: 'us-east-1',
      accessKeyId: exampleKeyId,
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00Z'),
    })
    expect(signed.headers['authorization']).toBe(
      `AWS4-HMAC-SHA256 Credential=${exampleKeyId}/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`,
    )
  })

  it('refuses plain http to anything but a local test server and invalid bucket names', () => {
    const base = { region: 'eu-central', accessKeyId: 'a', secretAccessKey: 'b', bucket: 'audit' }
    expect(() => s3CheckpointExporter({ ...base, endpoint: 'http://storage.example' })).toThrow()
    expect(() => s3CheckpointExporter({ ...base, endpoint: 'http://127.0.0.1:9000' })).not.toThrow()
    expect(() =>
      s3CheckpointExporter({ ...base, bucket: 'Bad_Bucket', endpoint: 'https://s.example' }),
    ).toThrow()
  })

  it('maps a refused upload to its status code without the response body', async () => {
    const sink = s3CheckpointExporter({
      endpoint: 'https://storage.example',
      region: 'eu-central',
      bucket: 'audit',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      fetch: async () => new Response('<Error>secret detail</Error>', { status: 403 }),
    })
    const error = await sink.export(document(1)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CheckpointExportError)
    expect(error).toMatchObject({ detailCode: 'http_403' })
    expect(String(error)).not.toContain('secret detail')
  })

  it('treats an existing object as exported only when it holds the same bytes', async () => {
    const stored = checkpointBytes(document(5))
    const responses = (body: Uint8Array) => {
      let call = 0
      return async () => {
        call += 1
        return call === 1 ? new Response(null, { status: 412 }) : new Response(body)
      }
    }
    const options = {
      endpoint: 'https://storage.example',
      region: 'eu-central',
      bucket: 'audit',
      accessKeyId: 'a',
      secretAccessKey: 'b',
    }
    await expect(
      s3CheckpointExporter({ ...options, fetch: responses(stored) }).export(document(5)),
    ).resolves.toEqual({ location: `s3://audit/${checkpointKey(document(5))}` })
    await expect(
      s3CheckpointExporter({ ...options, fetch: responses(new Uint8Array([1])) }).export(
        document(5),
      ),
    ).rejects.toMatchObject({ detailCode: 'conflict' })
  })

  it('sends a conditional, integrity-checked, optionally locked PUT', async () => {
    let seen: Headers | undefined
    const sink = s3CheckpointExporter({
      endpoint: 'https://storage.example',
      region: 'eu-central',
      bucket: 'audit',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      objectLock: { mode: 'COMPLIANCE', days: 3650 },
      now: () => new Date('2026-10-05T12:00:00Z'),
      fetch: async (_url, init) => {
        seen = new Headers(init?.headers)
        return new Response(null, { status: 200 })
      },
    })
    await sink.export(document(9))
    expect(seen?.get('if-none-match')).toBe('*')
    expect(seen?.get('content-md5')).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(seen?.get('x-amz-object-lock-mode')).toBe('COMPLIANCE')
    expect(seen?.get('x-amz-object-lock-retain-until-date')).toBe('2036-10-02T12:00:00Z')
    expect(seen?.get('authorization')).toMatch(
      /SignedHeaders=.*if-none-match.*x-amz-object-lock-mode/,
    )
  })
})

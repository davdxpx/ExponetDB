import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize, parseJson } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import { describe, expect, it } from 'vitest'
import {
  contractJsonSchema,
  JOB_REJECTION_REASONS,
  JobEnvelopeSchema,
  NODE_PROTOCOL_ID,
  NODE_PROTOCOL_MESSAGES,
} from '../src/index.ts'
import { readDoc, readRepoFile, repoRoot } from './docs.ts'

const dir = join(repoRoot(), 'tooling', 'fixtures', 'node-protocol')
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json'))

function load(file: string): unknown {
  const parsed = parseJson(readRepoFile(join('tooling', 'fixtures', 'node-protocol', file)))
  if (!parsed.ok) {
    throw new Error(`${file}: ${parsed.error.code}`)
  }
  return parsed.value
}

describe('node protocol envelopes', () => {
  it('uses the documented protocol id', () => {
    expect(NODE_PROTOCOL_ID).toBe('exponetdb.node/v1')
    expect(readDoc('07-node-agent/protocol.md')).toContain('`exponetdb.node/v1`')
  })

  it('has a fixture for every message, and every fixture validates', () => {
    const names = Object.keys(NODE_PROTOCOL_MESSAGES)
    for (const name of names) {
      expect(
        fixtures.some((f) => f.split('.')[0] === name),
        name,
      ).toBe(true)
    }
    for (const file of fixtures) {
      const name = file.split('.')[0] as keyof typeof NODE_PROTOCOL_MESSAGES
      const schema = NODE_PROTOCOL_MESSAGES[name]
      expect(schema, file).toBeDefined()
      const result = schema.safeParse(load(file))
      expect(result.success ? 'ok' : JSON.stringify(result.error.issues), file).toBe('ok')
    }
  })

  it('refuses unknown members in every message (closed within a protocol major)', () => {
    for (const file of fixtures) {
      const name = file.split('.')[0] as keyof typeof NODE_PROTOCOL_MESSAGES
      const value = load(file)
      const extended =
        typeof value === 'object' && value !== null ? { ...value, unexpected: true } : value
      expect(NODE_PROTOCOL_MESSAGES[name].safeParse(extended).success, file).toBe(false)
    }
  })

  it('binds args by argsHash = sha256 over JCS(args)', () => {
    const envelope = JobEnvelopeSchema.parse(load('JobEnvelope.json'))
    const canonical = canonicalize(envelope.args)
    if (!canonical.ok) {
      throw new Error(canonical.error.code)
    }
    expect(envelope.argsHash).toBe(`sha256:${sha256Hex(canonical.value)}`)
  })

  it('signs the canonical envelope without its signature member, deterministically', () => {
    const envelope = JobEnvelopeSchema.parse(load('JobEnvelope.json'))
    const { signature: _signature, ...unsigned } = envelope
    const reordered = Object.fromEntries(Object.entries(unsigned).reverse())
    expect(canonicalize(unsigned)).toEqual(canonicalize(reordered))
    const signed = canonicalize(unsigned)
    expect(signed.ok && !signed.value.includes('signature')).toBe(true)
  })

  it('refuses a job for a wrong capability format, a bad nonce or a non-Ed25519 signature', () => {
    const envelope = load('JobEnvelope.json') as Record<string, unknown>
    expect(
      JobEnvelopeSchema.safeParse({ ...envelope, capability: { name: 'exec', major: 1 } }).success,
    ).toBe(false)
    expect(JobEnvelopeSchema.safeParse({ ...envelope, nonce: 'short' }).success).toBe(false)
    expect(
      JobEnvelopeSchema.safeParse({
        ...envelope,
        signature: { alg: 'HS256', keyId: 'k', value: 'A'.repeat(86) },
      }).success,
    ).toBe(false)
    expect(
      JobEnvelopeSchema.safeParse({ ...envelope, nodeId: 'srv_01JB2Z0000000000000000000N' })
        .success,
    ).toBe(false)
  })

  it('lists the rejection reasons of protocol.md §4.2', () => {
    expect(JOB_REJECTION_REASONS).toContain('signature_invalid')
    expect(JOB_REJECTION_REASONS).toContain('job_replayed')
    expect(JOB_REJECTION_REASONS).toContain('nonce_replayed')
    expect(JOB_REJECTION_REASONS).toContain('args_hash_mismatch')
  })

  it('generates closed JSON Schemas for every message', () => {
    for (const [name, schema] of Object.entries(NODE_PROTOCOL_MESSAGES)) {
      const json = contractJsonSchema(schema, { io: 'input' })
      const root =
        (json['$defs'] as Record<string, Record<string, unknown>> | undefined)?.[
          String(json['$ref']).replace('#/$defs/', '')
        ] ?? json
      expect(root['additionalProperties'], name).toBe(false)
    }
  })
})

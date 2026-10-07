import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize, isJsonObject, type JsonValue, parseJson } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import { fromB64uOf, keyFingerprint, verifyJobEnvelope } from '@exponetdb/kernel/node'
import { describe, expect, it } from 'vitest'
import {
  contractJsonSchema,
  EnrollResponseSchema,
  isNodeCapabilityKey,
  JobEnvelopeSchema,
  NODE_CAPABILITIES,
  NODE_CAPABILITY_KEYS,
  type NodeCapabilityKey,
  ROLE_STEP_MEMBERS,
  timestampBefore,
} from '../src/index.ts'
import { readDoc, readRepoFile, repoRoot, section, tableRows } from './docs.ts'

const CAPABILITY_FIXTURES = join('tooling', 'fixtures', 'node-capabilities')
const PROTOCOL_FIXTURES = join('tooling', 'fixtures', 'node-protocol')

function load(relative: string): JsonValue {
  const parsed = parseJson(readRepoFile(relative))
  if (!parsed.ok) {
    throw new Error(`${relative}: ${parsed.error.code}`)
  }
  return parsed.value
}

function object(value: JsonValue, what: string): Record<string, JsonValue> {
  if (!isJsonObject(value)) {
    throw new Error(`${what}: expected an object`)
  }
  return value
}

const fixture = (key: string, part: 'args' | 'result') =>
  load(join(CAPABILITY_FIXTURES, `${key}.${part}.json`))

/** Capability names (without major) of a table cell such as "`disk.stats@1`, `memory.stats@1`". */
function namesIn(cell: string): string[] {
  return [...cell.matchAll(/`([a-z][a-z0-9_.]*)@1`/g)].map((m) => m[1] ?? '')
}

describe('node capability catalog (capabilities.md, G5 record §2)', () => {
  it('has argument and result fixtures for every capability, and nothing else', () => {
    const files = readdirSync(join(repoRoot(), CAPABILITY_FIXTURES)).filter((f) =>
      f.endsWith('.json'),
    )
    const expected = NODE_CAPABILITY_KEYS.flatMap((k) => [`${k}.args.json`, `${k}.result.json`])
    expect(files.sort()).toEqual(expected.sort())
  })

  it('validates every fixture and refuses an unknown member in each', () => {
    for (const key of NODE_CAPABILITY_KEYS) {
      for (const part of ['args', 'result'] as const) {
        const value = object(fixture(key, part), `${key}.${part}`)
        const schema = NODE_CAPABILITIES[key][part]
        const parsed = schema.safeParse(value)
        expect(parsed.success ? 'ok' : JSON.stringify(parsed.error.issues), `${key}.${part}`).toBe(
          'ok',
        )
        expect(schema.safeParse({ ...value, unexpected: true }).success, `${key}.${part}`).toBe(
          false,
        )
      }
    }
  })

  it('agrees with the catalog tables of capabilities.md on kind and reconciliation', () => {
    const doc = section(readDoc('07-node-agent/capabilities.md'), '## 1. Catalog')
    const documented = new Map<string, { kind: string; reconcile: string | undefined }>()
    for (const row of tableRows(doc)) {
      const kindCell = row[1] ?? ''
      const reconcileCell = row.length >= 5 ? (row[3] ?? '') : undefined
      for (const name of namesIn(row[0] ?? '')) {
        documented.set(name, {
          kind: kindCell.split(' ')[0] ?? '',
          reconcile:
            reconcileCell === undefined
              ? undefined
              : reconcileCell === '—'
                ? 'none'
                : (reconcileCell.split(' ')[0] ?? ''),
        })
      }
    }
    for (const key of NODE_CAPABILITY_KEYS) {
      const c = NODE_CAPABILITIES[key]
      const doc = documented.get(c.name)
      expect(doc, `${key} is not in capabilities.md §1`).toBeDefined()
      expect(c.kind, key).toBe(doc?.kind)
      if (doc?.reconcile !== undefined) {
        expect(c.reconcile, key).toBe(doc.reconcile)
      }
    }
  })

  it('holds exactly the capabilities the G5 scope matrix puts in Wave 5', () => {
    const matrix = section(readDoc('14-roadmap/gates/5.md'), '## 2. Capability scope matrix')
    const inScope = new Set<string>()
    for (const row of tableRows(matrix)) {
      if (row[1] !== 'yes') {
        continue
      }
      let base = ''
      for (const m of (row[0] ?? '').matchAll(/`([a-z._]+)`/g)) {
        const name = m[1] ?? ''
        if (name.startsWith('.')) {
          inScope.add(`${base}${name}`)
        } else {
          inScope.add(name)
          base = name.slice(0, name.lastIndexOf('.'))
        }
      }
    }
    const catalog = new Set(NODE_CAPABILITY_KEYS.map((k) => NODE_CAPABILITIES[k].name))
    expect([...catalog].sort()).toEqual([...inScope].sort())
  })

  it('takes no command, script, SQL or free path; every argument string is constrained (no generic shell)', () => {
    const forbidden = /^(command|cmd|script|shell|exec|argv|args|sql|query|statement|path|file)$/i
    const walk = (node: unknown, where: string, defs: Record<string, unknown>): void => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => {
          walk(n, `${where}[${i}]`, defs)
        })
        return
      }
      if (typeof node !== 'object' || node === null) {
        return
      }
      const schema = node as Record<string, unknown>
      const ref = schema['$ref']
      if (typeof ref === 'string') {
        walk(defs[ref.replace('#/$defs/', '')], `${where}→${ref}`, defs)
        return
      }
      if (schema['type'] === 'object') {
        expect(schema['additionalProperties'], `${where} is closed`).toBe(false)
      }
      if (schema['type'] === 'string') {
        const constrained =
          typeof schema['pattern'] === 'string' ||
          Array.isArray(schema['enum']) ||
          schema['const'] !== undefined ||
          typeof schema['format'] === 'string'
        expect(constrained, `${where} is a free string`).toBe(true)
      }
      const properties = schema['properties']
      if (typeof properties === 'object' && properties !== null) {
        for (const [name, inner] of Object.entries(properties)) {
          expect(forbidden.test(name), `${where}.${name}`).toBe(false)
          walk(inner, `${where}.${name}`, defs)
        }
      }
      for (const key of ['items', 'anyOf', 'oneOf', 'allOf']) {
        if (schema[key] !== undefined) {
          walk(schema[key], `${where}.${key}`, defs)
        }
      }
    }
    for (const key of NODE_CAPABILITY_KEYS) {
      const json = contractJsonSchema(NODE_CAPABILITIES[key].args, { io: 'input' })
      const defs = (json['$defs'] ?? {}) as Record<string, unknown>
      walk(json, `${key}.args`, defs)
    }
  })

  it('refuses every shared invalid fixture (the Go validator refuses the same set)', () => {
    const dir = join('tooling', 'fixtures', 'node-capabilities-invalid')
    const files = readdirSync(join(repoRoot(), dir)).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThanOrEqual(20)
    for (const file of files) {
      const key = file.slice(0, file.indexOf('@') + 2)
      expect(isNodeCapabilityKey(key), file).toBe(true)
      if (isNodeCapabilityKey(key)) {
        expect(NODE_CAPABILITIES[key].args.safeParse(load(join(dir, file))).success, file).toBe(
          false,
        )
      }
    }
  })

  it('names an effect point for every apply capability and none for reads and plans (ADR-0024 §5)', () => {
    for (const key of NODE_CAPABILITY_KEYS) {
      const c = NODE_CAPABILITIES[key]
      if (c.kind === 'apply') {
        expect(c.effectStep, key).not.toBeNull()
        expect(c.reconcile, key).not.toBe('none')
      } else {
        expect(c.effectStep, key).toBeNull()
        expect(c.reconcile, key).toBe('none')
      }
    }
  })

  it('seals every verifier: the sealed fields hold ns1 values in the fixtures', () => {
    const apply = object(fixture('postgres.roles.apply@1', 'args'), 'roles.apply')
    expect(NODE_CAPABILITIES['postgres.roles.apply@1'].sealedFields).toEqual([
      { path: 'steps[].verifier', field: 'verifier' },
    ])
    const steps = apply['steps']
    expect(Array.isArray(steps)).toBe(true)
    for (const step of Array.isArray(steps) ? steps : []) {
      const s = object(step, 'step')
      if (s['op'] === 'set_password') {
        expect(Object.keys(object(s['verifier'] ?? null, 'verifier'))).toEqual(['ns1'])
      }
    }
    // A plaintext password is not a sealed value.
    const plain = {
      ...apply,
      steps: [
        {
          ...object(Array.isArray(steps) ? (steps[0] ?? null) : null, 'step'),
          verifier: 'correct horse battery staple',
        },
      ],
    }
    expect(NODE_CAPABILITIES['postgres.roles.apply@1'].args.safeParse(plain).success).toBe(false)
  })

  it('enforces the members of each role step (ROLE_STEP_MEMBERS)', () => {
    const schema = NODE_CAPABILITIES['postgres.roles.apply@1'].args
    const base = object(fixture('postgres.roles.apply@1', 'args'), 'roles.apply')
    const nulls = {
      attributes: null,
      verifier: null,
      member: null,
      admin: null,
      inherit: null,
      set: null,
      database: null,
      setting: null,
      value: null,
    }
    const parse = (step: Record<string, unknown>) =>
      schema.safeParse({ ...base, steps: [{ ...nulls, role: 'app_user', ...step }] }).success
    expect(Object.keys(ROLE_STEP_MEMBERS).sort()).toEqual(
      [
        'alter_role',
        'clear_password',
        'create_role',
        'grant_membership',
        'reset_role_setting',
        'revoke_membership',
        'set_password',
        'set_role_setting',
      ].sort(),
    )
    expect(parse({ op: 'clear_password' })).toBe(true)
    expect(parse({ op: 'clear_password', member: 'x' })).toBe(false)
    expect(parse({ op: 'set_password' })).toBe(false)
    expect(parse({ op: 'revoke_membership', member: 'authenticated' })).toBe(true)
    expect(parse({ op: 'grant_membership', member: 'authenticated' })).toBe(false)
    expect(parse({ op: 'reset_role_setting', setting: 'work_mem' })).toBe(true)
    expect(parse({ op: 'reset_role_setting', setting: 'work_mem', database: 'db' })).toBe(true)
    expect(parse({ op: 'set_role_setting', setting: 'work_mem' })).toBe(false)
    // SUPERUSER is not an attribute a capability can set.
    expect(
      parse({
        op: 'alter_role',
        attributes: {
          login: null,
          inherit: null,
          createdb: null,
          createrole: null,
          replication: null,
          bypassrls: null,
          connectionLimit: null,
          superuser: true,
        },
      }),
    ).toBe(false)
  })

  it('refuses pg_hba rules that do not fit their type, and configuration values that span lines', () => {
    const hba = NODE_CAPABILITIES['postgres.hba.apply@1'].args
    const base = object(fixture('postgres.hba.apply@1', 'args'), 'hba.apply')
    const rule = {
      type: 'hostssl',
      database: ['all'],
      user: ['all'],
      address: '10.0.0.0/8',
      method: 'scram-sha-256',
      map: null,
    }
    const withRule = (r: Record<string, unknown>) =>
      hba.safeParse({ ...base, managedRules: [{ ...rule, ...r }] }).success
    expect(withRule({})).toBe(true)
    expect(withRule({ address: null })).toBe(false)
    expect(withRule({ type: 'local' })).toBe(false)
    expect(withRule({ method: 'peer', map: 'm' })).toBe(false)
    expect(withRule({ method: 'trust' })).toBe(false)
    expect(withRule({ type: 'host' })).toBe(false)
    expect(hba.safeParse({ ...base, protectedAccess: [] }).success).toBe(false)

    const config = NODE_CAPABILITIES['postgres.config.apply@1'].args
    const cfg = object(fixture('postgres.config.apply@1', 'args'), 'config.apply')
    const withValue = (value: string) =>
      config.safeParse({ ...cfg, parameters: [{ name: 'work_mem', value }] }).success
    expect(withValue('64MB')).toBe(true)
    expect(withValue("64MB'\ninclude '/etc/passwd")).toBe(false)
    expect(withValue('a\u0000b')).toBe(false)
  })

  it('signs the job envelope fixture with a trusted key over valid capability arguments', () => {
    const value = object(load(join(PROTOCOL_FIXTURES, 'JobEnvelope.json')), 'JobEnvelope')
    const envelope = JobEnvelopeSchema.parse(value)
    const key = `${envelope.capability.name}@${envelope.capability.major}`
    expect(isNodeCapabilityKey(key), key).toBe(true)
    if (!isNodeCapabilityKey(key)) {
      return
    }
    const capability: NodeCapabilityKey = key
    expect(NODE_CAPABILITIES[capability].args.safeParse(envelope.args).success).toBe(true)
    const canonical = canonicalize(envelope.args)
    expect(canonical.ok && `sha256:${sha256Hex(canonical.value)}`).toBe(envelope.argsHash)
    const response = EnrollResponseSchema.parse(
      load(join(PROTOCOL_FIXTURES, 'EnrollResponse.json')),
    )
    const trusted = response.jobKeys.map((k) => ({
      keyId: k.keyId,
      publicKey: fromB64uOf(k.publicKey, 32) ?? new Uint8Array(),
    }))
    expect(trusted.every((k) => keyFingerprint(k.publicKey).startsWith('sha256:'))).toBe(true)
    expect(verifyJobEnvelope(value, trusted)).toEqual({ ok: true, keyId: envelope.signature.keyId })
    expect(verifyJobEnvelope({ ...value, attempt: 2 }, trusted)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    })
  })

  it('accepts the arguments of the golden job-signature vectors', () => {
    const golden = object(load(join('tooling', 'golden', 'node-job-signature.json')), 'golden')
    const vectors = Array.isArray(golden['vectors']) ? golden['vectors'] : []
    expect(vectors.length).toBeGreaterThan(0)
    for (const v of vectors) {
      const envelope = object(object(v, 'vector')['envelope'] ?? null, 'envelope')
      const capability = object(envelope['capability'] ?? null, 'capability')
      const key = `${String(capability['name'])}@${String(capability['major'])}`
      // js-002 carries arbitrary arguments on purpose (escapes, nested arrays) to test the
      // signature alone; every other vector uses real postgres.reload@1 arguments.
      if (key === 'postgres.reload@1') {
        const args = object(envelope['args'] ?? null, 'args')
        if (Object.keys(args).length === 1) {
          expect(NODE_CAPABILITIES[key].args.safeParse(args).success).toBe(true)
        }
      }
    }
  })

  it('orders the log.inspect window at nanosecond precision, like the Go agent (review finding 11)', () => {
    const cases: readonly [string, string, boolean][] = [
      ['2026-10-07T12:00:00.0001Z', '2026-10-07T12:00:00.0002Z', true],
      ['2026-10-07T12:00:00.0002Z', '2026-10-07T12:00:00.0001Z', false],
      ['2026-10-07T12:00:00.0000000001Z', '2026-10-07T12:00:00.0000000009Z', false],
      ['2026-10-07T12:00:00Z', '2026-10-07T12:00:00.000000001Z', true],
      ['2026-10-07T11:59:59.999999999Z', '2026-10-07T12:00:00Z', true],
    ]
    const args = NODE_CAPABILITIES['log.inspect@1'].args
    for (const [since, until, ok] of cases) {
      expect(timestampBefore(since, until)).toBe(ok)
      const parsed = args.safeParse({
        source: 'agent',
        cluster: null,
        since,
        until,
        minSeverity: 'warning',
        maxLines: 10,
      })
      expect(parsed.success).toBe(ok)
    }
  })
})

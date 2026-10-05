import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { artifacts, CONTRACTS } from '../generators/artifacts.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (path: string): unknown => JSON.parse(readFileSync(join(root, path), 'utf8'))

/** A JSON object; every member is kept (a loose object never strips unknown keys). */
const JsonObjectSchema = z.looseObject({})

/** Reads a committed JSON file and validates it against `schema`. */
function readAs<S extends z.ZodType>(path: string, schema: S): z.output<S> {
  const parsed = schema.safeParse(read(path))
  if (!parsed.success) {
    throw new Error(`${path} does not have the expected shape: ${parsed.error.message}`)
  }
  return parsed.data
}

/** A validator that knows the ExponetDB annotation keywords and nothing else. */
function ajv(): Ajv2020 {
  const v = new Ajv2020({
    strict: true,
    allowUnionTypes: true,
    validateFormats: false,
    allErrors: false,
  })
  for (const keyword of [
    'untrusted',
    'x-extensible-enum',
    'x-exponetdb-raw-json',
    'x-exponetdb-endpoints',
    'x-exponetdb-limits',
    'x-exponetdb-messages',
  ]) {
    v.addKeyword(keyword)
  }
  return v
}

describe('generated artifacts', () => {
  it('are deterministic: identical bytes on every run', () => {
    const a = artifacts()
    const b = artifacts()
    expect([...a.keys()]).toEqual([...b.keys()])
    for (const [path, content] of a) {
      expect(b.get(path), path).toBe(content)
    }
  })

  it('carry no timestamps, absolute paths or machine-specific data', () => {
    for (const [path, content] of artifacts()) {
      expect(content, path).not.toMatch(/\/home\/|\/tmp\/|\/Users\/|C:\\\\/)
      expect(content, path).not.toMatch(/generated (at|on) \d{4}/i)
      expect(content.endsWith('\n'), path).toBe(true)
      expect(content, path).not.toContain('\r')
    }
  })

  it('match the committed files', () => {
    for (const [path, content] of artifacts()) {
      expect(readFileSync(join(root, path), 'utf8'), path).toBe(content)
    }
  })
})

describe('generated JSON Schema accepts and refuses what the Zod contracts accept and refuse', () => {
  const nodeProtocol = readAs(
    `${CONTRACTS}/jsonschema/node-protocol.v1.json`,
    z.looseObject({
      $defs: z.record(z.string(), z.unknown()),
      'x-exponetdb-messages': z.record(z.string(), z.looseObject({ $ref: z.string().optional() })),
    }),
  )
  const fixtures = join(root, 'tooling', 'fixtures', 'node-protocol')

  it('validates every node protocol fixture with its message schema, and refuses an unknown member', () => {
    const v = ajv()
    v.addSchema(nodeProtocol, 'node-protocol')
    for (const file of readdirSync(fixtures).filter((f) => f.endsWith('.json'))) {
      const name = file.split('.')[0] ?? ''
      const messageSchema = nodeProtocol['x-exponetdb-messages'][name]
      if (messageSchema === undefined) {
        throw new Error(`${file}: no message schema named ${name}`)
      }
      const ref = messageSchema.$ref ?? ''
      const validate = v.getSchema(`node-protocol${ref}`)
      expect(validate, file).toBeDefined()
      const value = JsonObjectSchema.parse(JSON.parse(readFileSync(join(fixtures, file), 'utf8')))
      expect(validate?.(value), `${file}: ${JSON.stringify(validate?.errors)}`).toBe(true)
      expect(validate?.({ ...value, unexpected: 1 }), file).toBe(false)
    }
  })

  it('validates the documented manifest and refuses a typo', () => {
    const v = ajv()
    const validate = v.compile(
      readAs(`${CONTRACTS}/jsonschema/migration-manifest.v1.json`, JsonObjectSchema),
    )
    const manifest = {
      schema: 'exponetdb.migration/v1',
      id: '01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
      name: 'add-lead-index',
      description: 'Adds a partial index.',
      dependsOn: ['01JB2YX7M3K5N7Q9S1V3W5Y7A9', 'baseline:shop-platform-2026-11'],
      execution: { transactional: true, lockTimeout: '5s' },
      compatibility: { declared: 'additive' },
      verification: { expectations: 'auto', runtimeChecks: 'verify.sql' },
    }
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true)
    expect(validate({ ...manifest, execution: { transactinal: true } })).toBe(false)
    expect(validate({ ...manifest, id: manifest.id.toLowerCase() })).toBe(false)
    expect(validate({ ...manifest, execution: { transactional: true, lockTimeout: '5 s' } })).toBe(
      false,
    )
  })

  it('compiles every MCP tool schema with an object root', () => {
    const doc = readAs(
      `${CONTRACTS}/jsonschema/mcp-tools.v1.json`,
      z.looseObject({
        tools: z.array(
          z.looseObject({
            name: z.string(),
            inputSchema: JsonObjectSchema,
            outputSchema: JsonObjectSchema,
          }),
        ),
      }),
    )
    expect(doc.tools.length).toBeGreaterThanOrEqual(20)
    for (const t of doc.tools) {
      const v = ajv()
      expect(() => v.compile(t.inputSchema), t.name).not.toThrow()
      expect(() => v.compile(t.outputSchema), t.name).not.toThrow()
      expect(t.inputSchema['type'], t.name).toBe('object')
    }
  })

  it('compiles the project configuration schema', () => {
    expect(() =>
      ajv().compile(readAs(`${CONTRACTS}/jsonschema/project-config.v1.json`, JsonObjectSchema)),
    ).not.toThrow()
  })

  it('compiles every component of the OpenAPI document', () => {
    const doc = readAs(
      `${CONTRACTS}/openapi.json`,
      z.looseObject({
        openapi: z.string(),
        components: z.looseObject({ schemas: z.record(z.string(), z.unknown()) }),
      }),
    )
    expect(doc.openapi).toMatch(/^3\.1\./)
    const v = new Ajv2020({ strict: false, validateFormats: false })
    v.addSchema({ $id: 'openapi', components: doc.components })
    for (const name of Object.keys(doc.components.schemas)) {
      expect(() => v.getSchema(`openapi#/components/schemas/${name}`), name).not.toThrow()
    }
  })
})

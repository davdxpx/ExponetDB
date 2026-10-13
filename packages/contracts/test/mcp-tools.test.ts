import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  EXPONETDB_META_KEYS,
  MCP_ADDRESS_PARAMETER_PATTERN,
  MCP_FORBIDDEN_PARAMETER_PATTERN,
  MCP_FORBIDDEN_TOOL_NAMES,
  MCP_FORBIDDEN_TOOL_PREFIXES,
  MCP_INSTRUCTIONS,
  MCP_SERVED_TOOL_LIST,
  MCP_TOOL_LIST,
  mcpCatalogDigest,
  mcpToolDefinition,
} from '../src/index.ts'

/**
 * The tool definitions as `tools/list` sends them (Wave 7 order §19, §21,
 * §35.2): what real clients accept, what an agent may never be offered.
 */
const definitions = MCP_TOOL_LIST.map(mcpToolDefinition)

interface Property {
  readonly name: string
  readonly path: string
  readonly schema: unknown
}

/** Every property of a JSON Schema, at any depth, with its path and schema. */
function properties(schema: unknown, path = ''): Property[] {
  if (Array.isArray(schema)) return schema.flatMap((s, i) => properties(s, `${path}[${i}]`))
  if (typeof schema !== 'object' || schema === null) return []
  const out: Property[] = []
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      for (const [name, sub] of Object.entries(value)) {
        out.push(
          { name, path: `${path}/${name}`, schema: sub },
          ...properties(sub, `${path}/${name}`),
        )
      }
    } else {
      out.push(...properties(value, `${path}/${key}`))
    }
  }
  return out
}

/** Whether a property schema can hold a scalar (an address is a string or a port number). */
function scalar(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return true
  const type = (schema as Record<string, unknown>)['type']
  const types = Array.isArray(type) ? type : [type]
  if (types.some((t) => t === 'string' || t === 'integer' || t === 'number')) return true
  const variants = ['anyOf', 'oneOf'].flatMap((k) => {
    const v = (schema as Record<string, unknown>)[k]
    return Array.isArray(v) ? v : []
  })
  return type === undefined && (variants.length === 0 || variants.some(scalar))
}

function keys(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(keys)
  if (typeof schema !== 'object' || schema === null) return []
  return Object.entries(schema).flatMap(([k, v]) => [k, ...keys(v)])
}

describe('MCP tool definitions on the wire', () => {
  it('have names a client accepts: [a-z0-9_], at most 48 characters, no dots', () => {
    for (const d of definitions) {
      expect(d.name, d.name).toMatch(/^[a-z][a-z0-9_]{0,47}$/)
    }
  })

  it('have static descriptions under 2 048 characters and a title', () => {
    for (const d of definitions) {
      expect(d.description.length, d.name).toBeLessThan(2048)
      expect(d.description.length, d.name).toBeGreaterThan(20)
      expect(d.title.length, d.name).toBeGreaterThan(2)
      expect(d.annotations.title, d.name).toBe(d.title)
      // Descriptions state the contract; they never address the model with rules.
      expect(d.description, d.name).not.toMatch(/\b(you must|always call|never call|ignore)\b/i)
    }
    // Two builds from the same contract are byte-identical (no runtime text).
    expect(JSON.stringify(MCP_TOOL_LIST.map(mcpToolDefinition))).toBe(JSON.stringify(definitions))
  })

  it('warn about untrusted fields exactly where a tool returns foreign text', () => {
    for (const t of MCP_TOOL_LIST) {
      if (t.annotations.openWorldHint) {
        expect(t.description, t.name).toContain('untrusted')
      }
    }
  })

  it('are self-contained: no $ref, $defs, $id or $schema anywhere', () => {
    for (const d of definitions) {
      for (const schema of [d.inputSchema, d.outputSchema]) {
        const all = keys(schema)
        expect(all, d.name).not.toContain('$ref')
        expect(all, d.name).not.toContain('$defs')
        expect(all, d.name).not.toContain('$id')
        expect(all, d.name).not.toContain('$schema')
      }
    }
  })

  it('have flat object roots: no anyOf, oneOf, allOf or not at the root of an input or output', () => {
    for (const d of definitions) {
      for (const schema of [d.inputSchema, d.outputSchema]) {
        expect(schema['type'], d.name).toBe('object')
        for (const combinator of ['anyOf', 'oneOf', 'allOf', 'not', 'if']) {
          expect(Object.keys(schema), `${d.name} ${combinator}`).not.toContain(combinator)
        }
      }
      expect(d.inputSchema['additionalProperties'], d.name).toBe(false)
      expect(d.outputSchema['additionalProperties'], d.name).toBe(false)
    }
  })

  it('take no confirmation, force, skip, override, dry-run or break-glass parameter at any depth', () => {
    for (const d of definitions) {
      for (const { name, path } of properties(d.inputSchema)) {
        expect(MCP_FORBIDDEN_PARAMETER_PATTERN.test(name), `${d.name}${path}`).toBe(false)
      }
    }
  })

  it('take and return no address, connection string or credential (C-4, C-20)', () => {
    for (const d of definitions) {
      for (const schema of [d.inputSchema, d.outputSchema]) {
        for (const { name, path, schema: property } of properties(schema)) {
          // `node_status.host` is an object of host metrics, not an address.
          if (!scalar(property)) continue
          expect(MCP_ADDRESS_PARAMETER_PATTERN.test(name), `${d.name}${path}`).toBe(false)
        }
      }
    }
    const nodeHost = properties(
      definitions.find((d) => d.name === 'node_status')?.outputSchema,
    ).find((p) => p.path === '/host')
    expect(nodeHost !== undefined && !scalar(nodeHost.schema)).toBe(true)
  })

  it('never name or start like a forbidden tool', () => {
    for (const d of definitions) {
      expect(MCP_FORBIDDEN_TOOL_NAMES as readonly string[], d.name).not.toContain(d.name)
      for (const prefix of MCP_FORBIDDEN_TOOL_PREFIXES) {
        expect(d.name.startsWith(prefix), `${d.name} ${prefix}`).toBe(false)
      }
    }
  })

  it('carry the tool version and action under ExponetDB keys', () => {
    for (const [i, d] of definitions.entries()) {
      const t = MCP_TOOL_LIST[i]
      expect(d._meta[EXPONETDB_META_KEYS.toolVersion]).toBe(t?.toolVersion)
      expect(d._meta[EXPONETDB_META_KEYS.action]).toBe(t?.action)
      expect(t?.action !== undefined && t.action in ACTIONS).toBe(true)
    }
  })

  it('fit the whole Wave 7 list into one page under the token budget', () => {
    const wave7 = MCP_TOOL_LIST.filter((t) => t.wave === '7').map(mcpToolDefinition)
    expect(wave7.length).toBeLessThanOrEqual(40)
    expect(MCP_SERVED_TOOL_LIST.length).toBeLessThanOrEqual(wave7.length)
    // Budget: 150 000 characters, about 37 500 tokens at four characters per token
    // (measured 2026-10-12: 136 540 for the 25 Wave 7 tools before sql_cancel).
    expect(JSON.stringify(wave7).length).toBeLessThan(150_000)
  })

  it('give a stable catalog digest', () => {
    const a = mcpCatalogDigest(MCP_SERVED_TOOL_LIST.map(mcpToolDefinition))
    const b = mcpCatalogDigest(MCP_SERVED_TOOL_LIST.map(mcpToolDefinition))
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(a).toBe(b)
  })

  it('do not change when an unrelated catalog value is added (no counts in relaxed enumerations)', () => {
    // An added action or error code once changed the definition of every tool that
    // returns one ("One of 197 values"): a client sees a changed list for no reason.
    for (const d of definitions) {
      expect(JSON.stringify(d.outputSchema), d.name).not.toMatch(/One of \d+ values/)
    }
  })
})

describe('MCP server instructions', () => {
  it('are static, at most 2 048 characters, and the first 512 name the essentials', () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(2048)
    const head = MCP_INSTRUCTIONS.slice(0, 512)
    for (const essential of [
      'target',
      'migration_plan',
      'plan_apply',
      'operation_get',
      'approval',
    ]) {
      expect(head, essential).toContain(essential)
    }
  })
})

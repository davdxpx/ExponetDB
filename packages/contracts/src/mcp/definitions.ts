import { canonicalize, InvariantError } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import type * as z from 'zod'
import { contractJsonSchema, type JsonSchema } from '../json-schema.ts'
import { EXPONETDB_META_KEYS } from './protocol.ts'
import { MCP_CATALOG_VERSION, type ToolAnnotations, type ToolContract } from './tools.ts'

/**
 * A tool as `tools/list` announces it. Built from the contract by one
 * function, used by the server and by the generator, so the published
 * catalog and the served list cannot differ.
 */
export interface McpToolDefinition {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
  readonly annotations: ToolAnnotations & { readonly title: string }
  readonly _meta: Readonly<Record<string, unknown>>
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Inlines every local `$ref` (`#/$defs/…`) so the schema is self-contained
 * and means the same in JSON Schema 2020-12 and Draft-07 (a sibling of
 * `$ref` is ignored in Draft-07): clients validate with either (Wave 7 order
 * §21, §35.2). A recursive definition (the JSON value of a row) becomes an
 * unconstrained schema that keeps its description. `$schema`, `$id` and
 * `$defs` are dropped: nothing refers to anything outside the document.
 */
export function inlineSchema(schema: JsonSchema): JsonSchema {
  const defs = isObject(schema['$defs']) ? schema['$defs'] : {}
  const walk = (node: unknown, stack: readonly string[]): Json => {
    if (Array.isArray(node)) {
      return node.map((n) => walk(n, stack))
    }
    if (!isObject(node)) {
      return node as Json
    }
    const ref = node['$ref']
    const out: Record<string, Json> = {}
    if (typeof ref === 'string') {
      const match = /^#\/\$defs\/(.+)$/.exec(ref)
      if (match === null) {
        throw new InvariantError(`non-local $ref in a tool schema: ${ref}`)
      }
      const name = match[1] ?? ''
      const target = defs[name]
      if (!isObject(target)) {
        throw new InvariantError(`unresolved $ref in a tool schema: ${ref}`)
      }
      if (stack.includes(name)) {
        // A recursive value (the JSON value of a row): any JSON type, said explicitly,
        // because a schema without a validation keyword is not portable (Inspector --strict).
        out['anyOf'] = JSON_TYPES.map((type) => ({ type }))
        const description = target['description']
        if (typeof description === 'string') out['description'] = description
      } else {
        Object.assign(out, walk(target, [...stack, name]) as Record<string, Json>)
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' || key === '$defs' || key === '$schema' || key === '$id') continue
      out[key] = walk(value, stack)
    }
    return out
  }
  const result = walk(schema, [])
  if (!isObject(result)) {
    throw new InvariantError('a tool schema must be an object')
  }
  return result as JsonSchema
}

const JSON_TYPES = ['object', 'array', 'string', 'number', 'boolean', 'null'] as const

/**
 * `type: [a, b]` becomes `anyOf: [{ type: a }, { type: b }]`: the same
 * meaning, and portable to clients that map tool schemas onto a dialect
 * with a single `type` (Inspector `--strict`, Wave 7 order §35.2).
 */
function singleTypes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(singleTypes)
  if (!isObject(node)) return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === 'type' ? value : singleTypes(value)
  }
  const type = node['type']
  if (Array.isArray(type)) {
    delete out['type']
    const branches = type.map((t) => ({ type: t }))
    out['anyOf'] = Array.isArray(out['anyOf'])
      ? [...(out['anyOf'] as unknown[]), ...branches]
      : branches
  }
  return out
}

/** Enumerations longer than this are announced as strings in output schemas. */
export const MCP_OUTPUT_ENUM_LIMIT = 16

/**
 * In an output schema, an enumeration of more than `MCP_OUTPUT_ENUM_LIMIT`
 * values (action ids, error codes, plan kinds) becomes a string with a
 * description naming the vocabulary, and the patterns of server-made values
 * (ids, digests) are left out: otherwise they are announced once per tool
 * and dominate `tools/list`. `maxLength` is left out too: the server escapes
 * invisible characters after it validated a result (one becomes up to eight,
 * `\u{200B}`), so an escaped string can be longer than the bound it passed
 * (`minLength` stays: escaping never shortens a string). The server still
 * validates every result with the full contract before it sends it; inputs
 * keep their enumerations, patterns and bounds.
 */
function relaxLargeEnums(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(relaxLargeEnums)
  if (!isObject(node)) return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    // A pattern of a server-made value (an id, a digest) tells a client nothing it can act on.
    if (key === 'pattern' && typeof value === 'string') continue
    // Escaping lengthens a value after it was validated (results.ts): a bound would reject valid output.
    if (key === 'maxLength' && typeof value === 'number') continue
    out[key] = relaxLargeEnums(value)
  }
  const values = node['enum']
  if (Array.isArray(values) && values.length > MCP_OUTPUT_ENUM_LIMIT) {
    delete out['enum']
    const sample = values.slice(0, 3).map(String).join(', ')
    // No count: adding an unrelated catalog value must not change the definition of every tool.
    const known = `One of the values of the ExponetDB catalog (for example ${sample}).`
    out['description'] =
      typeof node['description'] === 'string' ? `${node['description']} ${known}` : known
  }
  return out
}

/** The JSON Schema of a contract schema as MCP clients receive it. */
export function mcpWireSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const inlined = singleTypes(inlineSchema(contractJsonSchema(schema, { io }))) as JsonSchema
  return io === 'output' ? (relaxLargeEnums(inlined) as JsonSchema) : inlined
}

/**
 * The definition of one tool. Inputs are rendered as input schemas
 * (defaults optional); outputs as output schemas, where every object is
 * closed (`additionalProperties: false`): the server strips unknown keys
 * with the same contract before it sends a result.
 */
export function mcpToolDefinition(tool: ToolContract): McpToolDefinition {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: mcpWireSchema(tool.input, 'input'),
    outputSchema: mcpWireSchema(tool.output, 'output'),
    annotations: { title: tool.title, ...tool.annotations },
    _meta: {
      [EXPONETDB_META_KEYS.toolVersion]: tool.toolVersion,
      [EXPONETDB_META_KEYS.action]: tool.action,
    },
  }
}

/**
 * The digest of one tool's announced definition without its own version:
 * `sha256:` over the RFC 8785 canonical JSON of {@link mcpToolDefinition}
 * with `_meta.toolVersion` left out. The rule of `toolVersion`
 * (versioning.md §6, owner decision 2026-10-13): a served tool's definition
 * changes only together with a higher `toolVersion`, and each version names
 * exactly one digest, pinned in `packages/contracts/mcp-tool-versions.json`
 * (append-only; `bun run golden:history` refuses a changed entry).
 */
export function mcpToolDigest(tool: ToolContract): string {
  const { [EXPONETDB_META_KEYS.toolVersion]: _version, ...meta } = mcpToolDefinition(tool)._meta
  const canonical = canonicalize({ ...mcpToolDefinition(tool), _meta: meta })
  if (!canonical.ok) {
    throw new InvariantError(`the definition of ${tool.name} is not canonical JSON`)
  }
  return `sha256:${sha256Hex(canonical.value)}`
}

/**
 * The digest of a list of tool definitions: `sha256:` over the RFC 8785
 * canonical JSON. Logged and audited with every `tools/call` (a changed
 * list is visible), and pinned per grant shape by the tests.
 */
export function mcpCatalogDigest(definitions: readonly McpToolDefinition[]): string {
  const canonical = canonicalize({ catalog: MCP_CATALOG_VERSION, tools: definitions })
  if (!canonical.ok) {
    throw new InvariantError('tool definitions are not canonical JSON')
  }
  return `sha256:${sha256Hex(canonical.value)}`
}

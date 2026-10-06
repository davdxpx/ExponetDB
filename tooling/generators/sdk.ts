/**
 * The generated part of `@exponetdb/sdk` ([sdk.md §1](../../exponetdb-docs/13-integrations/sdk.md#1-generation)):
 * standalone TypeScript types for every OpenAPI component schema and every
 * `/api/v1` operation, plus a runtime table of the operations (method, path,
 * success status, wave). Derived from the OpenAPI document only, so the SDK
 * carries no Zod and no server package; a pure function (no clock, no
 * environment, sorted output) like every other generator.
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Obj = { [key: string]: Json }

const isObj = (v: Json | undefined): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const key = (name: string) => (IDENT.test(name) ? name : JSON.stringify(name))
const literal = (v: Json) => JSON.stringify(v)

function refName(ref: string): string {
  const prefix = '#/components/schemas/'
  if (!ref.startsWith(prefix)) throw new Error(`unsupported $ref ${ref}`)
  return ref.slice(prefix.length)
}

/** A TypeScript type for a JSON Schema (the subset the contracts produce). */
export function tsType(schema: Json | undefined, indent = ''): string {
  if (
    schema === undefined ||
    schema === true ||
    (isObj(schema) && Object.keys(schema).length === 0)
  ) {
    return 'unknown'
  }
  if (!isObj(schema)) return 'unknown'
  const ref = schema['$ref']
  if (typeof ref === 'string') return refName(ref)
  if ('const' in schema) return literal(schema['const'] ?? null)
  const enumValues = schema['enum']
  if (Array.isArray(enumValues)) return enumValues.map(literal).join(' | ')
  const union = schema['anyOf'] ?? schema['oneOf']
  if (Array.isArray(union)) {
    const parts = [...new Set(union.map((s) => tsType(s, indent)))]
    return parts.length === 1
      ? (parts[0] as string)
      : parts.map((p) => (p.includes('\n') ? `(${p})` : p)).join(' | ')
  }
  const allOf = schema['allOf']
  if (Array.isArray(allOf)) return allOf.map((s) => tsType(s, indent)).join(' & ')
  switch (schema['type']) {
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array': {
      const item = tsType(schema['items'], indent)
      return /^[A-Za-z0-9_]+$/.test(item) ? `readonly ${item}[]` : `ReadonlyArray<${item}>`
    }
    case 'object':
      return objectType(schema, indent)
    default:
      return 'unknown'
  }
}

function objectType(schema: Obj, indent: string): string {
  const properties = isObj(schema['properties']) ? schema['properties'] : {}
  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((r): r is string => typeof r === 'string')
      : [],
  )
  const names = Object.keys(properties).sort()
  const extra = schema['additionalProperties']
  const inner = `${indent}  `
  const lines = names.map((name) => {
    const optional = required.has(name) ? '' : '?'
    return `${inner}readonly ${key(name)}${optional}: ${tsType(properties[name], inner)}`
  })
  if (isObj(extra) || extra === true) {
    lines.push(
      `${inner}readonly [key: string]: ${extra === true ? 'unknown' : tsType(extra, inner)}`,
    )
  }
  if (lines.length === 0) {
    return extra === false ? 'Record<string, never>' : 'Record<string, unknown>'
  }
  return `{\n${lines.join('\n')}\n${indent}}`
}

function operationName(id: string): string {
  return id
}

/** The generated module: component types, the `Operations` type map and the `OPERATIONS` table. */
export function generateSdkTypes(openapi: Json): string {
  if (!isObj(openapi)) throw new Error('an OpenAPI document')
  const components = isObj(openapi['components']) ? openapi['components'] : {}
  const schemas = isObj(components['schemas']) ? components['schemas'] : {}
  const paths = isObj(openapi['paths']) ? openapi['paths'] : {}
  const out: string[] = [
    '// Generated from packages/contracts (OpenAPI 3.1) by tooling/generators/sdk.ts.',
    '// Do not edit by hand: run `bun run generate` (CI checks it is current).',
    '',
  ]
  for (const name of Object.keys(schemas).sort()) {
    out.push(`export type ${name} = ${tsType(schemas[name])}`, '')
  }
  interface Op {
    readonly id: string
    readonly method: string
    readonly path: string
    readonly status: number
    readonly wave: string
    readonly action: string
    readonly params: string
    readonly query: string
    readonly body: string
    readonly response: string
  }
  const ops: Op[] = []
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path]
    if (!isObj(item)) continue
    for (const method of Object.keys(item).sort()) {
      const op = item[method]
      if (!isObj(op) || typeof op['operationId'] !== 'string') continue
      const parameters = Array.isArray(op['parameters']) ? op['parameters'].filter(isObj) : []
      const fields = (where: string) => {
        const list = parameters
          .filter((p) => p['in'] === where && typeof p['name'] === 'string')
          .sort((a, b) => (String(a['name']) < String(b['name']) ? -1 : 1))
        if (list.length === 0) return 'Record<string, never>'
        return `{ ${list
          .map(
            (p) =>
              `readonly ${key(String(p['name']))}${p['required'] === true ? '' : '?'}: ${tsType(p['schema'])}`,
          )
          .join('; ')} }`
      }
      const requestBody = isObj(op['requestBody']) ? op['requestBody'] : undefined
      const bodyContent = isObj(requestBody?.['content']) ? requestBody['content'] : undefined
      const bodySchema = isObj(bodyContent?.['application/json'])
        ? bodyContent['application/json']['schema']
        : undefined
      const responses = isObj(op['responses']) ? op['responses'] : {}
      const success = Object.keys(responses)
        .filter((s) => /^2\d\d$/.test(s))
        .sort()[0]
      const response = success === undefined ? undefined : responses[success]
      const responseContent =
        isObj(response) && isObj(response['content']) ? response['content'] : undefined
      const responseSchema = isObj(responseContent?.['application/json'])
        ? responseContent['application/json']['schema']
        : undefined
      ops.push({
        id: operationName(op['operationId']),
        method,
        path,
        status: success === undefined ? 200 : Number(success),
        wave: typeof op['x-exponetdb-wave'] === 'string' ? op['x-exponetdb-wave'] : '',
        action: typeof op['x-exponetdb-action'] === 'string' ? op['x-exponetdb-action'] : '',
        params: fields('path'),
        query: fields('query'),
        body: bodySchema === undefined ? 'never' : tsType(bodySchema, '    '),
        response: responseSchema === undefined ? 'void' : tsType(responseSchema, '    '),
      })
    }
  }
  ops.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  out.push('/** Every `/api/v1` operation: path parameters, query, body and success response. */')
  out.push('export interface Operations {')
  for (const op of ops) {
    out.push(`  ${key(op.id)}: {`)
    out.push(`    readonly params: ${op.params}`)
    out.push(`    readonly query: ${op.query}`)
    out.push(`    readonly body: ${op.body}`)
    out.push(`    readonly response: ${op.response}`)
    out.push('  }')
  }
  out.push('}', '')
  out.push(
    '/** The operations at runtime: method, path template, success status, wave and action. */',
  )
  out.push('export const OPERATIONS = {')
  for (const op of ops) {
    out.push(
      `  ${key(op.id)}: { method: ${literal(op.method.toUpperCase())}, path: ${literal(op.path)}, status: ${op.status}, wave: ${literal(op.wave)}, action: ${literal(op.action)} },`,
    )
  }
  out.push('} as const', '')
  out.push('export type OperationId = keyof Operations', '')
  return `${out.join('\n')}`
}

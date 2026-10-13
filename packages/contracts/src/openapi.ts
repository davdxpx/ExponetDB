import type * as z from 'zod'
import { ACTIONS, type ActionDefinition } from './actions.ts'
import { ERRORS, type ErrorDefinition, ProblemSchema } from './errors.ts'
import { contractJsonSchema } from './json-schema.ts'
import {
  COMMON_ROUTE_ERRORS,
  REST_API_BASE_PATH,
  REST_API_VERSION,
  ROUTE_LIST,
  type RouteContract,
} from './rest/routes.ts'
import { MCP_BASELINE_SCOPES, SCOPE_IDS, SCOPES, tieredScope } from './scopes.ts'

/**
 * The OpenAPI 3.1 document of `/api/v1`, built from the route registry. The
 * generator writes it to `packages/contracts/generated/openapi.json` (and the
 * SDK's types from that file), and `serve` builds the same document with the
 * same function when it answers `GET /api/v1/openapi.json`: code imports the
 * contracts that produce a generated artifact, never the artifact itself.
 */

/** Deterministic JSON: members sorted by name (UTF-16 order), two-space indentation, LF, trailing newline. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep)
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(out, key, {
        value: sortDeep(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  }
  return value
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Moves `$defs` of a generated schema into a shared definitions map and
 * rewrites `#/$defs/X` references to `${prefix}X`. A name that already exists
 * must have an identical definition: one name, one shape.
 */
export function hoistDefinitions(
  schema: Record<string, unknown>,
  into: Map<string, unknown>,
  prefix: string,
): Record<string, unknown> {
  const { $defs, $schema: _schema, ...rest } = schema
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(rewrite)
    }
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node)) {
        out[k] =
          k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')
            ? `${prefix}${v.slice('#/$defs/'.length)}`
            : rewrite(v)
      }
      return out
    }
    return node
  }
  if (isPlainObject($defs)) {
    for (const [name, definition] of Object.entries($defs)) {
      const rewritten = rewrite(definition)
      const existing = into.get(name)
      if (existing !== undefined && stableStringify(existing) !== stableStringify(rewritten)) {
        throw new Error(`two different schemas use the id ${name}`)
      }
      into.set(name, rewritten)
    }
  }
  const out = rewrite(rest)
  if (!isPlainObject(out)) {
    throw new Error('schema root is not an object')
  }
  return out
}

/** Renames an annotation keyword everywhere in a schema tree (for OpenAPI's `x-` convention). */
export function renameKeyword(node: unknown, from: string, to: string): unknown {
  if (Array.isArray(node)) {
    return node.map((n) => renameKeyword(n, from, to))
  }
  if (isPlainObject(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k === from ? to : k, renameKeyword(v, from, to)]),
    )
  }
  return node
}

const COMPONENTS = '#/components/schemas/'

/** OpenAPI 3.1 document for the REST v1 read routes, generated from the route registry. */
export function buildOpenApi(): Record<string, unknown> {
  const schemas = new Map<string, unknown>()
  // OpenAPI tooling expects extension keywords to start with x-; MCP tool
  // schemas keep the documented `untrusted` keyword.
  const convert = (schema: z.ZodType): Record<string, unknown> => {
    const json = renameKeyword(
      contractJsonSchema(schema, { io: 'input' }),
      'untrusted',
      'x-untrusted',
    )
    if (!isPlainObject(json)) {
      throw new Error('schema root is not an object')
    }
    return hoistDefinitions(json, schemas, COMPONENTS)
  }

  const problem = convert(ProblemSchema)
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of ROUTE_LIST) {
    const path = paths[route.path] ?? {}
    path[route.method] = operation(route, convert)
    paths[route.path] = path
  }
  return {
    openapi: '3.1.1',
    'x-generated': 'Generated from packages/contracts by tooling/generators. Do not edit.',
    info: {
      title: 'ExponetDB REST API',
      version: REST_API_VERSION,
      description:
        'The REST API of the ExponetDB Control Plane: the read endpoints defined in Wave 1, the access, plan and approval endpoints of Wave 3A, the delegation endpoints of Wave 3B, the registry, schema, health and finding endpoints of Wave 4, and the node, migration, data-read and Control Plane endpoints of Waves 5 to 8. x-exponetdb-wave names the wave that contracted an operation. This document lists every contracted operation; an operation the running release does not serve yet answers 404 NOT_FOUND (application/problem+json) until it does. Errors are application/problem+json (RFC 9457) with the ExponetDB error catalog. Observed state carries source and observedAt; a failed live read is an error, never an empty list. A request carries exactly one credential: a Web App session (the __Host-exdb_session cookie; mutating requests also need X-CSRF-Token and the exact Origin), an OAuth access token for the audience https://db.exponet.cloud/api, or an API key of a service account. 401 and 403 answers carry a WWW-Authenticate Bearer challenge with resource_metadata (RFC 9728).',
      license: { name: 'Proprietary, all rights reserved', identifier: 'LicenseRef-Proprietary' },
    },
    jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    servers: [{ url: `https://db.exponet.cloud${REST_API_BASE_PATH}` }],
    paths,
    components: {
      schemas: Object.fromEntries(schemas),
      responses: {
        Problem: {
          description: 'An ExponetDB error (RFC 9457 problem document).',
          content: { 'application/problem+json': { schema: problem } },
        },
      },
      securitySchemes: {
        oauth2: {
          type: 'oauth2',
          description:
            'Opaque access tokens for the audience https://db.exponet.cloud/api (oauth.md).',
          flows: {
            // The device authorization grant (RFC 8628) of the first-party CLI has no
            // OpenAPI 3.1 flow type; it is described in the authorization server metadata.
            authorizationCode: {
              authorizationUrl: 'https://db.exponet.cloud/oauth/authorize',
              tokenUrl: 'https://db.exponet.cloud/oauth/token',
              refreshUrl: 'https://db.exponet.cloud/oauth/token',
              scopes: scopeDescriptions(),
            },
            clientCredentials: {
              tokenUrl: 'https://db.exponet.cloud/oauth/token',
              scopes: scopeDescriptions(),
            },
          },
        },
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'API key exak_… of a service account.',
        },
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Host-exdb_session',
          description:
            'First-party Web App session (Wave 3A). Mutating requests also need the X-CSRF-Token header and the exact Origin; a request with both a session cookie and a bearer token is refused.',
        },
      },
    },
    'x-exponetdb-mcp-baseline-scopes': [...MCP_BASELINE_SCOPES],
  }
}

function scopeDescriptions(): Record<string, string> {
  return Object.fromEntries(
    SCOPE_IDS.filter((s) => s !== 'api').map((s) => {
      const d = SCOPES[s]
      const notes = [
        d.tier === null ? 'untiered' : `tier ${d.tier}`,
        d.mcpGrantable ? 'MCP-grantable' : 'not MCP-grantable',
        d.humanOnly ? 'human session only' : '',
      ]
      return [s, `Needs permission ${d.permission}; ${notes.filter((n) => n !== '').join('; ')}.`]
    }),
  )
}

/**
 * The credential modes an action admits (Wave 3B): the session for `web`,
 * an OAuth access token for `cli`, `mcp` or `ci`, an API key only for `ci`
 * (service accounts). A request carries exactly one of them.
 */
function security(action: ActionDefinition): unknown[] {
  if (action.scope.kind === 'none') {
    return []
  }
  const session = action.clientKinds.includes('web') ? [{ session: [] }] : []
  const apiKey = action.clientKinds.includes('ci') ? [{ apiKey: [] }] : []
  if (!action.clientKinds.some((k) => k !== 'web')) {
    return session
  }
  switch (action.scope.kind) {
    case 'fixed':
      return [{ oauth2: [action.scope.scope] }, ...apiKey, ...session]
    case 'tiered': {
      const scopes = [
        tieredScope(action.scope.permission, 'nonprod'),
        tieredScope(action.scope.permission, 'prod'),
      ]
      return [...scopes.map((s) => ({ oauth2: [s] })), ...apiKey, ...session]
    }
    default:
      return [{ oauth2: [] }, ...apiKey, ...session]
  }
}

function parameters(
  location: 'path' | 'query',
  object: z.ZodObject | undefined,
  convert: (s: z.ZodType) => Record<string, unknown>,
): unknown[] {
  if (object === undefined) {
    return []
  }
  const schema = convert(object)
  const properties = isPlainObject(schema['properties']) ? schema['properties'] : {}
  const required = new Set(Array.isArray(schema['required']) ? schema['required'] : [])
  return Object.entries(properties).map(([name, propertySchema]) => {
    const param: Record<string, unknown> = {
      name,
      in: location,
      required: location === 'path' || required.has(name),
      schema: propertySchema,
    }
    if (isPlainObject(propertySchema) && propertySchema['type'] === 'array') {
      param['style'] = 'form'
      param['explode'] = true
    }
    return param
  })
}

function operation(
  route: RouteContract,
  convert: (s: z.ZodType) => Record<string, unknown>,
): Record<string, unknown> {
  const action: ActionDefinition = ACTIONS[route.action]
  const codes = [...new Set([...COMMON_ROUTE_ERRORS, ...route.errors])]
  const byStatus = new Map<number, string[]>()
  for (const code of codes) {
    const def: ErrorDefinition = ERRORS[code]
    byStatus.set(def.status, [...(byStatus.get(def.status) ?? []), code])
  }
  const responses: Record<string, unknown> = {
    [String(route.response.status)]: {
      description:
        route.response.status === 201
          ? 'Created.'
          : route.response.status === 202
            ? 'Accepted.'
            : 'OK.',
      content: { 'application/json': { schema: convert(route.response.schema) } },
    },
  }
  for (const [status, list] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    responses[String(status)] = {
      description: `Error codes: ${list.sort().join(', ')}.`,
      $ref: '#/components/responses/Problem',
    }
  }
  const op: Record<string, unknown> = {
    operationId: route.operationId,
    summary: route.summary,
    tags: [route.path.split('/')[1] ?? 'root'],
    parameters: [
      ...parameters('path', route.pathParams, convert),
      ...parameters('query', route.query, convert),
    ],
    responses,
    security: security(action),
    'x-exponetdb-action': route.action,
    // The wave that serves the operation: a route of a later wave is contract
    // only and answers 404 until that wave ships (the server test keeps every
    // route of a delivered wave served).
    'x-exponetdb-wave': action.wave,
    'x-exponetdb-action-class':
      action.class.kind === 'fixed' ? action.class.class : action.class.kind,
    'x-exponetdb-errors': codes.sort(),
  }
  if (route.body !== undefined) {
    op['requestBody'] = {
      required: true,
      content: { 'application/json': { schema: convert(route.body) } },
    }
  }
  return op
}

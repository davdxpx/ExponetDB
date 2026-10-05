import {
  ACTIONS,
  type ActionDefinition,
  COMMON_ROUTE_ERRORS,
  contractJsonSchema,
  ERRORS,
  type ErrorDefinition,
  MCP_BASELINE_SCOPES,
  ProblemSchema,
  REST_API_BASE_PATH,
  REST_API_VERSION,
  ROUTE_LIST,
  type RouteContract,
  SCOPE_IDS,
  SCOPES,
  tieredScope,
} from '@exponetdb/contracts'
import type * as z from 'zod'
import { hoistDefinitions, isObject, renameKeyword } from './json.ts'

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
    if (!isObject(json)) {
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
        'Read endpoints of /api/v1 defined in Wave 1. Errors are application/problem+json (RFC 9457) with the ExponetDB error catalog. Observed state carries source and observedAt; a failed live read is an error, never an empty list.',
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

function security(action: ActionDefinition): unknown[] {
  switch (action.scope.kind) {
    case 'fixed':
      return [{ oauth2: [action.scope.scope] }, { apiKey: [] }]
    case 'tiered': {
      const scopes = [
        tieredScope(action.scope.permission, 'nonprod'),
        tieredScope(action.scope.permission, 'prod'),
      ]
      return [...scopes.map((s) => ({ oauth2: [s] })), { apiKey: [] }]
    }
    default:
      return [{ oauth2: [] }, { apiKey: [] }]
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
  const properties = isObject(schema['properties']) ? schema['properties'] : {}
  const required = new Set(Array.isArray(schema['required']) ? schema['required'] : [])
  return Object.entries(properties).map(([name, propertySchema]) => {
    const param: Record<string, unknown> = {
      name,
      in: location,
      required: location === 'path' || required.has(name),
      schema: propertySchema,
    }
    if (isObject(propertySchema) && propertySchema['type'] === 'array') {
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
      description: route.response.status === 201 ? 'Created.' : 'OK.',
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

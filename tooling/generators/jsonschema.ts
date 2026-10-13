import {
  ACTION_IDS,
  ACTIONS,
  AUTH_BASE_PATH,
  AUTH_ROUTES,
  BUILT_IN_ROLE_IDS,
  BUILT_IN_ROLES,
  CLIENT_KINDS,
  CONTRACT_VERSIONS,
  contractJsonSchema,
  ERROR_CODES,
  ERRORS,
  type ErrorDefinition,
  errorTypeUri,
  MCP_CATALOG_VERSION,
  MCP_TOOL_LIST,
  mcpToolDefinition,
  migrationManifestJsonSchema,
  NODE_CAPABILITIES,
  NODE_PROTOCOL_ENDPOINTS,
  NODE_PROTOCOL_HEADER,
  NODE_PROTOCOL_ID,
  NODE_PROTOCOL_LIMITS,
  NODE_PROTOCOL_MESSAGES,
  PERMISSION_IDS,
  PERMISSIONS,
  projectConfigJsonSchema,
  SCOPE_IDS,
  SCOPES,
} from '@exponetdb/contracts'
import type * as z from 'zod'
import { hoistDefinitions } from './json.ts'

const DIALECT = 'https://json-schema.org/draft/2020-12/schema'
const GENERATED = 'Generated from packages/contracts by tooling/generators. Do not edit.'

/** A standalone schema document with its own `$defs`. */
function standalone(
  id: string,
  schema: z.ZodType,
  io: 'input' | 'output',
): Record<string, unknown> {
  const defs = new Map<string, unknown>()
  const root = hoistDefinitions(contractJsonSchema(schema, { io }), defs, '#/$defs/')
  return {
    $schema: DIALECT,
    $id: id,
    $comment: GENERATED,
    ...root,
    ...(defs.size > 0 ? { $defs: Object.fromEntries(defs) } : {}),
  }
}

/** The contracts build these documents themselves (they are also served at `/schemas/...`). */
export function migrationManifestSchema(): Record<string, unknown> {
  return migrationManifestJsonSchema()
}

export function projectConfigSchema(): Record<string, unknown> {
  return projectConfigJsonSchema()
}

/** Every node protocol message as a top-level definition (input of the Go type generator). */
export function nodeProtocolSchema(): Record<string, unknown> {
  const defs = new Map<string, unknown>()
  const messages: Record<string, unknown> = {}
  for (const [name, schema] of Object.entries(NODE_PROTOCOL_MESSAGES)) {
    const root = hoistDefinitions(contractJsonSchema(schema, { io: 'input' }), defs, '#/$defs/')
    // A message whose root is a reference to its own id becomes that definition.
    const ref = root['$ref']
    messages[name] = typeof ref === 'string' ? { $ref: ref } : root
  }
  // Capability arguments and results (capabilities.ts): every one is a named
  // definition, so the Go generator gives each its own strict type.
  const capabilities: Record<string, unknown> = {}
  for (const [key, c] of Object.entries(NODE_CAPABILITIES)) {
    const reference = (schema: z.ZodType, part: string): unknown => {
      const root = hoistDefinitions(contractJsonSchema(schema, { io: 'input' }), defs, '#/$defs/')
      if (typeof root['$ref'] !== 'string') {
        throw new Error(`capability ${key}: ${part} schema needs a meta id`)
      }
      return { $ref: root['$ref'] }
    }
    capabilities[key] = {
      name: c.name,
      major: c.major,
      kind: c.kind,
      path: c.path,
      reconcile: c.reconcile,
      effectStep: c.effectStep,
      reloadStep: c.reloadStep,
      sealedFields: c.sealedFields,
      runSeconds: c.runSeconds,
      settleSeconds: c.settleSeconds,
      args: reference(c.args, 'args'),
      result: reference(c.result, 'result'),
    }
  }
  return {
    $schema: DIALECT,
    $id: 'https://db.exponet.cloud/schemas/node-protocol/v1',
    $comment: GENERATED,
    title: NODE_PROTOCOL_ID,
    description: `Messages of ${NODE_PROTOCOL_ID}; every request carries ${NODE_PROTOCOL_HEADER}: ${NODE_PROTOCOL_ID}.`,
    'x-exponetdb-endpoints': NODE_PROTOCOL_ENDPOINTS,
    'x-exponetdb-limits': NODE_PROTOCOL_LIMITS,
    'x-exponetdb-messages': messages,
    'x-exponetdb-capabilities': capabilities,
    $defs: Object.fromEntries(defs),
  }
}

/**
 * The MCP tools exactly as `tools/list` announces them (one builder for the
 * server and this document), each with its state: `served` tools are offered
 * to a grant that can use them, `planned` ones never.
 */
export function mcpToolsDocument(): Record<string, unknown> {
  return {
    $comment: GENERATED,
    catalog: MCP_CATALOG_VERSION,
    tools: MCP_TOOL_LIST.map((t) => ({
      ...mcpToolDefinition(t),
      'x-exponetdb': {
        status: t.status,
        wave: t.wave,
        rateClass: t.rateClass,
        restOperationId: t.restOperationId,
        limits: t.limits,
        ...(t.bundleBody === true ? { bundleBody: true } : {}),
      },
    })),
  }
}

/** Errors, permissions, scopes and actions as data for consumers outside TypeScript. */
export function catalogDocument(): Record<string, unknown> {
  return {
    $comment: GENERATED,
    contracts: CONTRACT_VERSIONS,
    clientKinds: [...CLIENT_KINDS],
    errors: ERROR_CODES.map((code) => {
      const d: ErrorDefinition = ERRORS[code]
      return {
        code,
        type: errorTypeUri(code),
        group: d.group,
        status: d.status,
        ...(d.statusNote === undefined ? {} : { statusNote: d.statusNote }),
        retryable: d.retryable,
        title: d.title,
        message: d.message,
        ...(d.remediation === undefined ? {} : { remediation: d.remediation }),
        details:
          d.details === undefined
            ? null
            : standalone(`https://db.exponet.cloud/schemas/errors/${code}`, d.details, 'input'),
      }
    }),
    permissions: PERMISSION_IDS.map((id) => ({ id, ...PERMISSIONS[id] })),
    scopes: SCOPE_IDS.map((id) => ({ id, ...SCOPES[id] })),
    actions: ACTION_IDS.map((id) => ({ id, ...ACTIONS[id] })),
    roles: BUILT_IN_ROLE_IDS.map((id) => ({ id, ...BUILT_IN_ROLES[id] })),
    authRoutes: AUTH_ROUTES.map((r) => ({
      operationId: r.operationId,
      method: r.method,
      path: `${AUTH_BASE_PATH}${r.path}`,
      action: r.action,
      errors: [...r.errors].sort(),
    })),
  }
}

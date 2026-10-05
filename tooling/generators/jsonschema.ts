import {
  ACTION_IDS,
  ACTIONS,
  CLIENT_KINDS,
  CONTRACT_VERSIONS,
  contractJsonSchema,
  ERROR_CODES,
  ERRORS,
  type ErrorDefinition,
  errorTypeUri,
  MCP_CATALOG_VERSION,
  MCP_READ_TOOL_LIST,
  MigrationManifestSchema,
  NODE_PROTOCOL_ENDPOINTS,
  NODE_PROTOCOL_HEADER,
  NODE_PROTOCOL_ID,
  NODE_PROTOCOL_LIMITS,
  NODE_PROTOCOL_MESSAGES,
  PERMISSION_IDS,
  PERMISSIONS,
  ProjectConfigSchema,
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

export function migrationManifestSchema(): Record<string, unknown> {
  return standalone(
    'https://db.exponet.cloud/schemas/migration-manifest/v1',
    MigrationManifestSchema,
    'input',
  )
}

export function projectConfigSchema(): Record<string, unknown> {
  return standalone(
    'https://db.exponet.cloud/schemas/project-config/v1',
    ProjectConfigSchema,
    'input',
  )
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
  return {
    $schema: DIALECT,
    $id: 'https://db.exponet.cloud/schemas/node-protocol/v1',
    $comment: GENERATED,
    title: NODE_PROTOCOL_ID,
    description: `Messages of ${NODE_PROTOCOL_ID}; every request carries ${NODE_PROTOCOL_HEADER}: ${NODE_PROTOCOL_ID}.`,
    'x-exponetdb-endpoints': NODE_PROTOCOL_ENDPOINTS,
    'x-exponetdb-limits': NODE_PROTOCOL_LIMITS,
    'x-exponetdb-messages': messages,
    $defs: Object.fromEntries(defs),
  }
}

/** The MCP read tools with their JSON Schemas, as an MCP server lists them. */
export function mcpToolsDocument(): Record<string, unknown> {
  return {
    $comment: GENERATED,
    catalog: MCP_CATALOG_VERSION,
    tools: MCP_READ_TOOL_LIST.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: standalone(
        `https://db.exponet.cloud/schemas/mcp/v1/${t.name}/input`,
        t.input,
        'input',
      ),
      outputSchema: standalone(
        `https://db.exponet.cloud/schemas/mcp/v1/${t.name}/output`,
        t.output,
        'input',
      ),
      annotations: t.annotations,
      _meta: {
        toolVersion: t.toolVersion,
        action: t.action,
        restOperationId: t.restOperationId,
        limits: t.limits,
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
  }
}

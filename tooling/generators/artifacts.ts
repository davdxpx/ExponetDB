import { MIGRATION_AUTHORING_GUIDE } from '@exponetdb/contracts'
import { generateGoProtocol } from './go.ts'
import { stableStringify } from './json.ts'
import {
  catalogDocument,
  mcpToolsDocument,
  migrationManifestSchema,
  nodeProtocolSchema,
  projectConfigSchema,
} from './jsonschema.ts'
import { buildOpenApi } from './openapi.ts'
import { generateSdkTypes } from './sdk.ts'

export const CONTRACTS = 'packages/contracts/generated'
export const GO_PROTOCOL = 'agent/node/internal/protocol/types_gen.go'
/** The node protocol JSON Schema embedded in the agent for argument and result validation. */
export const GO_SCHEMA = 'agent/node/internal/protocol/schema_gen.json'
export const SDK_GENERATED = 'packages/sdk/src/generated'
/** The MCP resources' Markdown, readable in the documentation (the server embeds the same text). */
export const MCP_RESOURCE_DOCS = 'exponetdb-docs/05-mcp/resources'

/** Every generated artifact by repository-relative path. Pure: no I/O, no clock, no environment. */
export function artifacts(): Map<string, string> {
  const nodeProtocol = nodeProtocolSchema()
  const openapi = stableStringify(buildOpenApi())
  return new Map<string, string>([
    [`${CONTRACTS}/openapi.json`, openapi],
    [`${CONTRACTS}/catalog.json`, stableStringify(catalogDocument())],
    [
      `${CONTRACTS}/jsonschema/migration-manifest.v1.json`,
      stableStringify(migrationManifestSchema()),
    ],
    [`${CONTRACTS}/jsonschema/project-config.v1.json`, stableStringify(projectConfigSchema())],
    [`${CONTRACTS}/jsonschema/node-protocol.v1.json`, stableStringify(nodeProtocol)],
    [`${CONTRACTS}/jsonschema/mcp-tools.v1.json`, stableStringify(mcpToolsDocument())],
    [GO_PROTOCOL, generateGoProtocol(nodeProtocol)],
    [GO_SCHEMA, stableStringify(nodeProtocol)],
    [`${SDK_GENERATED}/api.ts`, generateSdkTypes(JSON.parse(openapi))],
    [
      `${MCP_RESOURCE_DOCS}/migration-authoring.md`,
      `<!-- Generated from packages/contracts (MIGRATION_AUTHORING_GUIDE) by tooling/generators. Do not edit; served as exponetdb://guides/migration-authoring. -->\n\n${MIGRATION_AUTHORING_GUIDE}`,
    ],
  ])
}

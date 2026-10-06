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
export const SDK_GENERATED = 'packages/sdk/src/generated'

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
    [`${SDK_GENERATED}/api.ts`, generateSdkTypes(JSON.parse(openapi))],
  ])
}

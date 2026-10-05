import { MIGRATION_MANIFEST_SCHEMA_ID } from './manifest/migration.ts'
import { PROJECT_CONFIG_SCHEMA_ID } from './manifest/project.ts'
import { MCP_CATALOG_VERSION } from './mcp/tools.ts'
import { NODE_PROTOCOL_ID } from './node-protocol/messages.ts'
import { REST_API_VERSION } from './rest/routes.ts'

/** Version identifiers of every contract (versioning.md §1). */
export const CONTRACT_VERSIONS = {
  restApi: REST_API_VERSION,
  mcpCatalog: MCP_CATALOG_VERSION,
  nodeProtocol: NODE_PROTOCOL_ID,
  migrationManifest: MIGRATION_MANIFEST_SCHEMA_ID,
  projectConfig: PROJECT_CONFIG_SCHEMA_ID,
  checksumCanonicalizer: 'c1',
  ledgerStateHash: 'ls1',
  fingerprintCanonicalizer: 'fp1',
} as const

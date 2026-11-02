/**
 * The limits of bundles in one place (VC-095): the constants the table in
 * [migration-bundles.md §1](../../../exponetdb-docs/04-migrations/migration-bundles.md) lists,
 * so a test can compare the table with them.
 */
export {
  MAX_COMMENT_DEPTH,
  MAX_COMMENT_RUN,
  MAX_MIGRATION_PARSE_BYTES,
  MAX_MIGRATION_STATEMENTS,
  MAX_PARSE_BYTES,
  MAX_PARSE_TOKENS,
  MAX_REQUEST_PARSE_TOKENS,
} from '@exponetdb/postgres/parser'
export { MAX_YAML_FLOW_DEPTH } from './format/yaml.ts'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BUNDLE_FILE_LIMITS,
  MIGRATION_BODY_LIMIT_BYTES,
  MIGRATION_REQUEST_LIMITS,
} from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import { MAX_YAML_FLOW_DEPTH } from '../src/format/yaml.ts'
import {
  MAX_COMMENT_DEPTH,
  MAX_COMMENT_RUN,
  MAX_MIGRATION_PARSE_BYTES,
  MAX_MIGRATION_STATEMENTS,
  MAX_PARSE_BYTES,
  MAX_PARSE_TOKENS,
  MAX_REQUEST_PARSE_TOKENS,
} from '../src/lint/limits.ts'

/**
 * VC-095: the limits of bundles are announced in one table of migration-bundles.md; a value that
 * changes in the code and not in the table fails here.
 */
const doc = readFileSync(
  fileURLToPath(
    new URL('../../../exponetdb-docs/04-migrations/migration-bundles.md', import.meta.url),
  ),
  'utf8',
)

/** The value cell of the table row that names this constant. */
function documented(constant: string): string {
  const row = doc.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${constant}\``))
  if (row === undefined) throw new Error(`${constant} is not in the limits table`)
  return row.split('|')[2]?.trim() ?? ''
}

const MIB = 1024 * 1024

describe('the table of bundle limits in migration-bundles.md (VC-095)', () => {
  it.each([
    ['MAX_PARSE_BYTES', MAX_PARSE_BYTES, `${MAX_PARSE_BYTES / MIB} MiB`],
    [
      'MAX_MIGRATION_PARSE_BYTES',
      MAX_MIGRATION_PARSE_BYTES,
      `${MAX_MIGRATION_PARSE_BYTES / MIB} MiB`,
    ],
    ['MAX_PARSE_TOKENS', MAX_PARSE_TOKENS, MAX_PARSE_TOKENS.toLocaleString('en-US')],
    ['MAX_COMMENT_DEPTH', MAX_COMMENT_DEPTH, String(MAX_COMMENT_DEPTH)],
    ['MAX_COMMENT_RUN', MAX_COMMENT_RUN, String(MAX_COMMENT_RUN)],
    [
      'MAX_MIGRATION_STATEMENTS',
      MAX_MIGRATION_STATEMENTS,
      MAX_MIGRATION_STATEMENTS.toLocaleString('en-US'),
    ],
    [
      'MAX_REQUEST_PARSE_TOKENS',
      MAX_REQUEST_PARSE_TOKENS,
      MAX_REQUEST_PARSE_TOKENS.toLocaleString('en-US'),
    ],
    ['MAX_YAML_FLOW_DEPTH', MAX_YAML_FLOW_DEPTH, String(MAX_YAML_FLOW_DEPTH)],
  ])('%s is documented as %s', (name, value, text) => {
    expect(value).toBeGreaterThan(0)
    expect(documented(name)).toBe(text)
  })

  it('documents the size of every bundle file', () => {
    const row = documented('BUNDLE_FILE_LIMITS')
    const size = (bytes: number) => (bytes >= MIB ? `${bytes / MIB} MiB` : `${bytes / 1024} KiB`)
    for (const [name, bytes] of Object.entries(BUNDLE_FILE_LIMITS)) {
      expect(row, name).toContain(`\`${name}\``)
      expect(row, name).toContain(size(bytes))
    }
  })

  it('names the number of bundles of a request', () => {
    expect(documented('MIGRATION_REQUEST_LIMITS')).toContain(
      String(MIGRATION_REQUEST_LIMITS.bundles),
    )
  })

  it('names the body limit of a bundle request', () => {
    expect(documented('MIGRATION_REQUEST_LIMITS')).toContain(
      `${MIGRATION_BODY_LIMIT_BYTES / MIB} MiB`,
    )
  })
})

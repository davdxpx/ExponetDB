import { describe, expect, it } from 'vitest'
import { scratchCopyCommands } from '../src/format/index.ts'

/**
 * The schema-only copy commands for a scratch target (legacy-import.md
 * §2.5, follow-up 2 F3). Run once against PostgreSQL 17 on 2026-10-22: both
 * schemas copied, a quoted name too, no row, no trigger and no trigger
 * comment, the unnamed schema left out.
 */
describe('scratchCopyCommands', () => {
  it('dumps exactly the named schemas, leaves their triggers out, and restores in one transaction', () => {
    const text = scratchCopyCommands({
      schemas: ['auth', 'storage', 'auth'],
      targetPath: 'acme/platform/staging',
      scratchPath: 'acme/platform/scratch',
    })
    expect(text).toContain(
      `pg_dump --schema-only --format=custom --file=exdb-scratch-copy.dump --schema='"auth"' --schema='"storage"' "$IMPORTED_URL"`,
    )
    expect(text).toContain(`grep -v -E '^[0-9]+; [0-9]+ [0-9]+ (TRIGGER|COMMENT [^ ]+ TRIGGER) '`)
    expect(text).toContain(
      'pg_restore --exit-on-error --single-transaction --use-list=exdb-scratch-copy.list --dbname="$SCRATCH_URL"',
    )
    expect(text).toContain('set -euo pipefail')
    // No credential is ever part of it.
    expect(text).not.toMatch(/password|PGPASSWORD/i)
  })

  it('keeps a schema name inside its pattern and its shell quotes', () => {
    const text = scratchCopyCommands({ schemas: [`Odd "Sch'ema*`, '$(touch x)'] })
    expect(text).toContain(`--schema='"Odd ""Sch'\\''ema*"'`)
    expect(text).toContain(`--schema='"$(touch x)"'`)
  })

  it('refuses no schema and a name with control characters', () => {
    expect(() => scratchCopyCommands({ schemas: [] })).toThrow()
    expect(() => scratchCopyCommands({ schemas: ['a\nrm -rf /'] })).toThrow()
    expect(() => scratchCopyCommands({ schemas: ['x'.repeat(64)] })).toThrow()
  })
})

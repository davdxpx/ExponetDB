import { readFileSync } from 'node:fs'
import {
  ImportAnalysisRequestSchema,
  LEGACY_FILES_LIMIT_BYTES,
  ScratchCheckRequestSchema,
} from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import { issues } from '../src/interfaces/http/api.ts'

/**
 * A legacy history is parsed in serve (follow-up 2, F4): a history above
 * the bound is refused before anything is parsed, naming the bound, by both
 * routes that carry one; every role runs with WebAssembly tier-up off.
 */
describe('legacy parse work in serve', () => {
  it('refuses a history above the bound as /files too_large, before any parse', () => {
    // Three files of 3 MiB: each within the file bound, more than the history bound together.
    const big = 'SELECT 1;\n'.repeat((3 * 1024 * 1024) / 10)
    const files = [
      { name: '0001_a.sql', text: big },
      { name: '0002_b.sql', text: big },
      { name: '0003_c.sql', text: big },
    ]
    for (const parsed of [
      ScratchCheckRequestSchema.safeParse({ scratchTarget: 'acme/platform/scratch', files }),
      ImportAnalysisRequestSchema.safeParse({
        scratchTarget: 'acme/platform/scratch',
        baseline: 'acme-2026',
        files,
      }),
    ]) {
      expect(parsed.success).toBe(false)
      if (parsed.success) return
      expect(issues(parsed.error.issues)).toEqual([
        {
          path: '/files',
          code: 'too_large',
          message: expect.stringMatching(new RegExp(`^At most ${LEGACY_FILES_LIMIT_BYTES} bytes`)),
        },
      ])
    }
    expect(
      ScratchCheckRequestSchema.safeParse({
        scratchTarget: 'acme/platform/scratch',
        files: [{ name: '0001_a.sql', text: 'SELECT 1;\n'.repeat(1000) }],
      }).success,
    ).toBe(true)
  })

  it('starts every role of the image with V8 tier-up of WebAssembly off', () => {
    // Measured on Node 24.22 in a 512 MiB container (deployment.md §2a): without it the
    // optimizing compiler's memory for the parser had the process killed on one 3.6 MiB file.
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8')
    expect(dockerfile).toContain('ENTRYPOINT ["node", "--liftoff-only", "/app/bin/exponetdb.mjs"]')
    expect(dockerfile).toContain(
      'CMD ["node", "--liftoff-only", "/app/bin/exponetdb.mjs", "healthcheck"]',
    )
  })
})

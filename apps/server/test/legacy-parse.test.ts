import { readFileSync } from 'node:fs'
import {
  ImportAnalysisRequestSchema,
  LEGACY_FILES_LIMIT_BYTES,
  ScratchCheckRequestSchema,
} from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import { issues, LEGACY_REQUESTS_IN_FLIGHT, legacyRequest } from '../src/interfaces/http/api.ts'
import { problemResponse } from '../src/interfaces/http/request.ts'

/**
 * A legacy history is parsed in serve (follow-up 2, F4): a history above
 * the bound is refused before anything is parsed, naming the bound, by both
 * routes that carry one; every role runs with WebAssembly tier-up off.
 */
describe('legacy parse work in serve', () => {
  it('works on two histories at once and answers a third with RATE_LIMITED and Retry-After (verification review P3-7)', async () => {
    expect(LEGACY_REQUESTS_IN_FLIGHT).toBe(2)
    const releases: (() => void)[] = []
    const held = () =>
      legacyRequest(
        () =>
          new Promise<string>((resolve) => {
            releases.push(() => resolve('done'))
          }),
      )
    const first = held()
    const second = held()
    const busy = await legacyRequest(async () => 'never').catch((e: unknown) => e)
    const response = problemResponse('req_01M5K000000000000000000001' as never, busy, {
      retryAfterSeconds: (busy as { retryAfterSeconds: number }).retryAfterSeconds,
    })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(await response.json()).toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 5 },
    })
    for (const release of releases) release()
    expect([await first, await second]).toEqual(['done', 'done'])
    // The slots are free again, also after a failure.
    await expect(legacyRequest(async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(await legacyRequest(async () => 'again')).toBe('again')
  })

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

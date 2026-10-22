import { readFileSync } from 'node:fs'
import { LEGACY_FILES_LIMIT_BYTES, ScratchCheckRequestSchema } from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import { issues, LEGACY_PARSE_SLOTS, oneLegacyParse } from '../src/interfaces/http/api.ts'
import { problemResponse } from '../src/interfaces/http/request.ts'

/**
 * A legacy history is parsed in serve (follow-up 2, F4): one such request
 * at a time, a second one is told to try again; a history above the bound
 * is refused before anything is parsed, naming the bound.
 */
describe('legacy parse work in serve', () => {
  it('runs one at a time and answers another with RATE_LIMITED and Retry-After', async () => {
    expect(LEGACY_PARSE_SLOTS).toBe(1)
    let release: () => void = () => undefined
    const first = oneLegacyParse(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('done')
        }),
    )
    const busy = await oneLegacyParse(async () => 'never').catch((e: unknown) => e)
    const response = problemResponse('req_01M5K000000000000000000001' as never, busy, {
      retryAfterSeconds: (busy as { retryAfterSeconds: number }).retryAfterSeconds,
    })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(await response.json()).toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 5 },
    })
    release()
    expect(await first).toBe('done')
    // The slot is free again, also after a failure.
    await expect(oneLegacyParse(async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(await oneLegacyParse(async () => 'again')).toBe('again')
  })

  it('refuses a history above the bound as /files too_large, before any parse', () => {
    // Three files of 3 MiB: each within the file bound, more than the history bound together.
    const big = 'SELECT 1;\n'.repeat((3 * 1024 * 1024) / 10)
    const parsed = ScratchCheckRequestSchema.safeParse({
      scratchTarget: 'acme/platform/scratch',
      files: [
        { name: '0001_a.sql', text: big },
        { name: '0002_b.sql', text: big },
        { name: '0003_c.sql', text: big },
      ],
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(issues(parsed.error.issues)).toEqual([
      {
        path: '/files',
        code: 'too_large',
        message: expect.stringMatching(new RegExp(`^At most ${LEGACY_FILES_LIMIT_BYTES} bytes`)),
      },
    ])
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

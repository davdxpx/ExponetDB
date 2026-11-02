import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * TC-063: the gate documents name the tests that prove their rows. Seven of the names pointed at
 * files that do not exist (renamed or never written), so a row read as proven by nothing. Every
 * test file a gate document names exists.
 */
const root = new URL('../../', import.meta.url).pathname
const docs = join(root, 'exponetdb-docs')
const FILES = [
  ...readdirSync(join(docs, '14-roadmap/gates'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `14-roadmap/gates/${f}`),
  '14-roadmap/acceptance-gates.md',
  '05-mcp/protocol-baseline.md',
  '15-cli/owner-test-package.md',
]
const NAMED_TEST =
  /`((?:apps|packages|tooling|agent)\/[A-Za-z0-9_./-]+(?:\.(?:test|spec)\.(?:ts|tsx)|_test\.go))`/g

describe('the test files the gate documents name (TC-063)', () => {
  it('reads the gate documents', () => {
    expect(FILES.length).toBeGreaterThan(8)
    for (const f of FILES) expect(existsSync(join(docs, f)), f).toBe(true)
  })

  it('all exist', () => {
    const missing = FILES.flatMap((file) =>
      readFileSync(join(docs, file), 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          [...line.matchAll(NAMED_TEST)]
            .map((m) => m[1] as string)
            .filter((path) => !existsSync(join(root, path)))
            .map((path) => `${file}:${i + 1} ${path}`),
        ),
    )
    expect(missing).toEqual([])
  })
})

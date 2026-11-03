import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * VC-056: `operations.plan_bodies.body` is text. A stored body can hold an escaped NUL (` `),
 * which is not valid `jsonb`, so one active plan of any kind made every query that cast bodies
 * with a bare `body::jsonb` fail with 500 (planning a node revoke was one, appliedElsewhere
 * another). Every such cast goes through `replace(body, '\u0000', '�')::jsonb`.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'generated') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path)
  }
  return out
}

describe('casts of stored plan bodies to jsonb (VC-056)', () => {
  it('never cast a bare body to jsonb', () => {
    const offenders: string[] = []
    for (const area of ['packages', 'apps']) {
      for (const dir of readdirSync(join(ROOT, area))) {
        const src = join(ROOT, area, dir, 'src')
        try {
          if (!statSync(src).isDirectory()) continue
        } catch {
          continue
        }
        for (const file of sources(src)) {
          const lines = readFileSync(file, 'utf8').split('\n')
          for (const [i, line] of lines.entries()) {
            if (/\bbody::jsonb\b/.test(line) && !/replace\(\s*[a-z.]*body\b/.test(line)) {
              offenders.push(`${file.slice(ROOT.length)}:${i + 1}`)
            }
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

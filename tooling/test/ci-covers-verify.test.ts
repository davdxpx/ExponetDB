import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * VC-081: `bun run verify` runs third-party, licenses and ui-safety, which guard ADR-0030 and
 * OD-38, but no CI job ran them: a pull request with an unregistered copied file or a bad
 * license was not stopped. The checks `verify` runs that need no browser, database or Go
 * toolchain are CI steps too.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const verify = (
  JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { scripts: Record<string, string> }
).scripts['verify']
const workflow = readFileSync(`${ROOT}.github/workflows/ci.yml`, 'utf8')

describe('the CI workflow and bun run verify (VC-081)', () => {
  it.each(['third-party', 'licenses', 'ui-safety', 'boundaries', 'secrets', 'verify:generated'])(
    'runs %s in both',
    (script) => {
      expect(verify, `verify lacks ${script}`).toContain(`bun run ${script}`)
      expect(workflow, `ci.yml lacks ${script}`).toContain(`bun run ${script}`)
    },
  )

  it('never cancels the run of a commit on main', () => {
    expect(workflow).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}")
  })
})

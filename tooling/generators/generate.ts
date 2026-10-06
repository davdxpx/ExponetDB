import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifacts, CONTRACTS, SDK_GENERATED } from './artifacts.ts'

/**
 * Regenerates every committed contract artifact from packages/contracts.
 *
 *   bun run generate          write the artifacts
 *   bun run verify:generated  regenerate in memory twice, fail on any byte
 *                             difference between the runs or against the
 *                             committed files (drift or a hand edit)
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function listGenerated(dir: string): string[] {
  const out: string[] = []
  let entries: { name: string; isDirectory(): boolean }[]
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const path = `${dir}/${e.name}`
    if (e.isDirectory()) {
      out.push(...listGenerated(path))
    } else {
      out.push(path)
    }
  }
  return out
}

const first = artifacts()
const second = artifacts()
for (const [path, content] of first) {
  if (second.get(path) !== content) {
    console.error(`non-deterministic output: ${path}`)
    process.exit(1)
  }
}

if (process.argv.includes('--check')) {
  const problems: string[] = []
  for (const [path, content] of first) {
    let committed: string | undefined
    try {
      committed = readFileSync(join(root, path), 'utf8')
    } catch {
      committed = undefined
    }
    if (committed !== content) {
      problems.push(
        committed === undefined ? `missing: ${path}` : `out of date or edited by hand: ${path}`,
      )
    }
  }
  for (const path of [
    ...listGenerated(CONTRACTS),
    ...listGenerated(SDK_GENERATED),
    ...listGenerated('agent/node/internal/protocol').filter((p) => p.endsWith('_gen.go')),
  ]) {
    if (!first.has(path)) {
      problems.push(`not produced by the generators: ${path}`)
    }
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    console.error('Run `bun run generate` and commit the result.')
    process.exit(1)
  }
  console.log(`generated artifacts are up to date (${first.size} files, deterministic)`)
} else {
  for (const [path, content] of first) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
    console.log(`wrote ${relative(root, join(root, path))}`)
  }
}

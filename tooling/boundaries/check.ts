import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cruise, type IViolation } from 'dependency-cruiser'
import { z } from 'zod'
import { allowedComponents, forbidden, graph, options } from './rules.mjs'

/**
 * Package boundary check (package-architecture.md §2, C-2):
 *
 * 1. import-level rules over every TypeScript file with dependency-cruiser
 *    (allowed graph, no cycles, no REOSA or Supabase, no generated imports,
 *    no product → tooling, no node builtins in browser-safe code);
 * 2. manifest-level rules over every package.json, the lockfile and go.mod;
 * 3. repository layout rules (no submodules, no vendor copies);
 * 4. the package graph, rendered from the manifests and committed
 *    (tooling/boundaries/package-graph.md); `--write` updates it.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const write = process.argv.includes('--write')
const problems: string[] = []

export async function importViolations(baseDir: string, scan: string[]): Promise<IViolation[]> {
  const result = await cruise(
    scan,
    { ...options, validate: true, ruleSet: { forbidden }, baseDir },
    options.enhancedResolveOptions,
  )
  if (typeof result.output === 'string') {
    throw new Error('unexpected string output from dependency-cruiser')
  }
  return result.output.summary.violations
}

const ManifestSchema = z.looseObject({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
})
type Manifest = z.infer<typeof ManifestSchema>

function readManifest(file: string): Manifest {
  const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
  if (!parsed.success) {
    throw new Error(`${relative(root, file)}: ${parsed.error.message}`)
  }
  return parsed.data
}

function workspaceManifests(): { dir: string; manifest: Manifest }[] {
  const out: { dir: string; manifest: Manifest }[] = []
  for (const parent of ['packages', 'apps']) {
    const base = join(root, parent)
    if (!existsSync(base)) {
      continue
    }
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const file = join(base, entry.name, 'package.json')
      if (entry.isDirectory() && existsSync(file)) {
        out.push({
          dir: `${parent}/${entry.name}`,
          manifest: readManifest(file),
        })
      }
    }
  }
  out.push({
    dir: 'tooling',
    manifest: readManifest(join(root, 'tooling', 'package.json')),
  })
  out.push({
    dir: '.',
    manifest: readManifest(join(root, 'package.json')),
  })
  return out
}

/** The components that live in a workspace directory (a package can hold several subpaths). */
function componentsIn(dir: string): string[] {
  return Object.entries(graph.components)
    .filter(([, c]) => c.path.startsWith(`^${dir}/`))
    .map(([name]) => name)
}

/** Everything any component of `dir` may import, plus its own components. */
function allowedForManifest(dir: string): Set<string> {
  const own = componentsIn(dir)
  return new Set([...own, ...own.flatMap((c) => allowedComponents(c))])
}

function manifestChecks(): string {
  const manifests = workspaceManifests()
  const edges: string[] = []
  for (const { dir, manifest } of manifests) {
    const all = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    }
    for (const [name, spec] of Object.entries(all)) {
      if (/reosa|supabase/i.test(name) || /reosa|supabase/i.test(spec)) {
        problems.push(
          `${dir}/package.json: dependency on REOSA or Supabase (${name}@${spec}) violates C-2`,
        )
      }
      if (/^(git\+|git:|github:|https?:|file:|link:)/.test(spec)) {
        problems.push(`${dir}/package.json: ${name} uses a non-registry source (${spec})`)
      }
      if (
        !name.startsWith('@exponetdb/') &&
        !spec.startsWith('workspace:') &&
        // An exact version, or an npm alias to an exact version (one parser build per PostgreSQL major).
        !/^(?:npm:(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*@)?\d+\.\d+\.\d+$/.test(spec)
      ) {
        problems.push(`${dir}/package.json: ${name}@${spec} is not pinned to an exact version`)
      }
    }
    const runtime = Object.keys(manifest.dependencies ?? {})
    const rules = graph.runtimeDependencies
    for (const dep of runtime) {
      if (rules.forbidden.includes(dep)) {
        problems.push(
          `${dir}/package.json: ${dep} is not allowed in ExponetDB (graph.json runtimeDependencies)`,
        )
      }
      const allowedIn = rules.allowedIn[dep]
      if (allowedIn !== undefined && !allowedIn.includes(dir)) {
        problems.push(
          `${dir}/package.json: ${dep} may only be used in ${allowedIn.join(', ')} (graph.json runtimeDependencies)`,
        )
      }
    }
    const allowed = allowedForManifest(dir)
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (!dep.startsWith('@exponetdb/') || dir === '.') {
        continue
      }
      const targetDir = `packages/${dep.slice('@exponetdb/'.length)}`
      edges.push(
        `  ${dir.replace('/', '_').replace('.', 'root')}["${manifest.name}"] --> ${targetDir.replace('/', '_')}`,
      )
      const targets = componentsIn(targetDir)
      if (targetDir !== dir && targets.length > 0 && !targets.some((t) => allowed.has(t))) {
        problems.push(
          `${dir}/package.json: ${manifest.name} must not depend on ${dep} (package-architecture.md §2)`,
        )
      }
    }
  }
  const lock = readFileSync(join(root, 'bun.lock'), 'utf8')
  if (/"@?(reosa|supabase)[/@"]/i.test(lock)) {
    problems.push('bun.lock: contains a REOSA or Supabase package (C-2)')
  }
  const goMod = readFileSync(join(root, 'agent', 'node', 'go.mod'), 'utf8')
  if (/^\s*require\b/m.test(goMod)) {
    problems.push('agent/node/go.mod: Wave 1 Go code uses the standard library only')
  }
  if (/reosa|supabase/i.test(goMod)) {
    problems.push('agent/node/go.mod: references REOSA or Supabase (C-2)')
  }
  const nodes = manifests
    .filter((m) => m.dir !== '.')
    .map((m) => `  ${m.dir.replace('/', '_')}["${m.manifest.name}"]`)
    .sort()
  return [
    '# Package graph',
    '',
    'Generated by `bun run boundaries -- --write` from the workspace manifests;',
    'checked in CI against the allowed graph in `graph.json`',
    '([package-architecture.md §2](../../exponetdb-docs/01-architecture/package-architecture.md#2-dependency-rules)).',
    '',
    '```mermaid',
    'graph TD',
    ...nodes,
    ...[...new Set(edges)].sort(),
    '```',
    '',
  ].join('\n')
}

/**
 * Every `uses:` of a workflow names a full commit SHA (supply chain, G1 A10).
 * Local actions (`./…`) and container images (`docker://…`) are out of scope
 * here; images in workflows are pinned by digest where they are used.
 */
export function unpinnedActions(workflow: string): string[] {
  const out: string[] = []
  for (const [i, line] of workflow.split('\n').entries()) {
    const m = /^\s*(?:-\s+)?uses:\s*(['"]?)([^\s'"#]+)\1/.exec(line)
    const ref = m?.[2]
    if (ref === undefined || ref.startsWith('./') || ref.startsWith('docker://')) {
      continue
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(ref)) {
      out.push(`line ${i + 1}: ${ref}`)
    }
  }
  return out
}

function workflowChecks(): void {
  const dir = join(root, '.github', 'workflows')
  if (!existsSync(dir)) {
    return
  }
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    for (const hit of unpinnedActions(readFileSync(join(dir, file), 'utf8'))) {
      problems.push(`.github/workflows/${file} ${hit}: action not pinned to a full commit SHA`)
    }
  }
}

function layoutChecks(): void {
  if (existsSync(join(root, '.gitmodules'))) {
    problems.push('.gitmodules exists: no submodules (C-2)')
  }
  for (const forbiddenDir of [
    'vendor',
    'supabase',
    'reosa',
    'packages/supabase',
    'packages/reosa',
    'vendor/supabase',
  ]) {
    if (existsSync(join(root, forbiddenDir))) {
      problems.push(`${forbiddenDir}/ exists: no vendor copies of REOSA or Supabase (C-2)`)
    }
  }
}

async function main(): Promise<void> {
  const scan = ['packages', 'apps', 'tooling'].filter((d) => existsSync(join(root, d)))
  for (const v of await importViolations(root, scan)) {
    problems.push(`${v.from} → ${v.to}: ${v.rule.name}`)
  }
  const rendered = manifestChecks()
  layoutChecks()
  workflowChecks()
  const graphFile = join(root, 'tooling', 'boundaries', 'package-graph.md')
  if (write) {
    writeFileSync(graphFile, rendered)
    console.log(`wrote ${relative(root, graphFile)}`)
  } else if (!existsSync(graphFile) || readFileSync(graphFile, 'utf8') !== rendered) {
    problems.push(
      'tooling/boundaries/package-graph.md is out of date: run `bun run boundaries -- --write`',
    )
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log(
    `boundaries hold (${Object.keys(graph.components).length} components modeled, ${scan.join(', ')} scanned)`,
  )
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}

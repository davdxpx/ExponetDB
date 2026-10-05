// Turns graph.json into dependency-cruiser rules. Plain JavaScript because
// dependency-cruiser loads its configuration without TypeScript.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const graph = JSON.parse(readFileSync(join(here, 'graph.json'), 'utf8'))

/** Allowed components of `name`: its direct edges plus every foundation reachable through them. */
export function allowedComponents(name) {
  const components = graph.components
  const direct = components[name]?.allowed ?? []
  const allowed = new Set(direct)
  if (graph.noFoundations.includes(name)) {
    return [...allowed]
  }
  const seen = new Set()
  const stack = [...direct]
  while (stack.length > 0) {
    const next = stack.pop()
    if (seen.has(next)) {
      continue
    }
    seen.add(next)
    if (graph.foundations.includes(next)) {
      allowed.add(next)
    }
    stack.push(...(components[next]?.allowed ?? []))
  }
  return [...allowed]
}

/** A path regex matches only the files of that component (subpaths of a package are carved out). */
function ownPathNot(name) {
  const own = graph.components[name].path
  // Paths of other components nested inside this one (e.g. postgres/parser inside postgres).
  return Object.entries(graph.components)
    .filter(([other, c]) => other !== name && c.path.startsWith(own) && c.path !== own)
    .map(([, c]) => c.path)
}

/** The npm name a component is imported by: packages/<x> → @exponetdb/<x>, migrations/<sub> → @exponetdb/migrations/<sub>. */
export function moduleNameOf(name) {
  const path = graph.components[name]?.path ?? ''
  const pkg = /^\^packages\/([^/]+)\/(?:src\/([^/]+)\/)?$/.exec(path)
  if (pkg === null) {
    return undefined
  }
  return pkg[2] === undefined ? `@exponetdb/${pkg[1]}` : `@exponetdb/${pkg[1]}/${pkg[2]}`
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

export function boundaryRules() {
  const rules = []
  for (const [name, component] of Object.entries(graph.components)) {
    const allowed = allowedComponents(name)
    const allowedPaths = allowed.map((dep) => graph.components[dep].path)
    const comment = `${name} may depend on: ${allowed.join(', ') || 'nothing'} (package-architecture.md §2)`
    rules.push({
      name: `boundary:${name}`,
      severity: 'error',
      comment,
      from: { path: component.path, pathNot: ownPathNot(name) },
      to: { path: '^(packages|apps|tooling)/', pathNot: [component.path, ...allowedPaths] },
    })
    // The same rule by module name, for imports that do not resolve to a path
    // (an undeclared workspace dependency does not resolve under isolated installs).
    const ownName = moduleNameOf(name)
    const allowedNames = [ownName, ...allowed.map(moduleNameOf)].filter((n) => n !== undefined)
    rules.push({
      name: `boundary-by-name:${name}`,
      severity: 'error',
      comment,
      from: { path: component.path, pathNot: ownPathNot(name) },
      to: { path: '^@exponetdb/', pathNot: allowedNames.map((n) => `^${escapeRegExp(n)}(/|$)`) },
    })
  }
  return rules
}

export const forbidden = [
  ...boundaryRules(),
  {
    name: 'no-unresolvable-import',
    severity: 'error',
    comment:
      'Every import must resolve; an undeclared or misspelled dependency is never silently skipped.',
    from: { path: '^(packages|apps|tooling)/' },
    to: { couldNotResolve: true },
  },
  {
    name: 'no-circular',
    severity: 'error',
    comment: 'Circular dependencies break layering.',
    from: { path: '^(packages|apps|tooling)/' },
    to: { circular: true },
  },
  {
    name: 'no-reosa-or-supabase',
    severity: 'error',
    comment: 'C-2: ExponetDB never depends on REOSA or the Supabase repository.',
    from: {},
    to: { path: '(^|/)(@?reosa|@supabase|supabase)(/|$)' },
  },
  {
    name: 'no-generated-import',
    severity: 'error',
    comment: 'Generated artifacts are outputs; code imports the contracts that produce them.',
    from: { path: '^(packages|apps)/' },
    to: { path: '(^|/)generated/|_gen\\.go$' },
  },
  {
    name: 'no-product-to-tooling',
    severity: 'error',
    comment: 'Product code never imports repository tooling or golden data.',
    from: { path: '^(packages|apps)/' },
    to: { path: '^tooling/' },
  },
  {
    name: 'no-testing-harness-in-product',
    severity: 'error',
    comment:
      'The integration test harness (@exponetdb/control-store/testing) is for tests only; product code never imports it.',
    from: { path: '^(packages|apps)/[^/]+/src/', pathNot: '^packages/control-store/src/testing/' },
    to: { path: '^packages/control-store/src/testing/' },
  },
  {
    name: 'no-src-to-test',
    severity: 'error',
    comment: 'Production code never imports tests.',
    from: { path: '^(packages|apps)/[^/]+/src/' },
    to: { path: '^(packages|apps)/[^/]+/test/' },
  },
  {
    name: 'no-node-builtins-in-browser-safe-code',
    severity: 'error',
    comment:
      'contracts and the kernel root are browser-safe; node:crypto lives only in @exponetdb/kernel/hash.',
    from: { path: '^packages/(contracts/src/|kernel/src/(?!hash/))' },
    to: { dependencyTypes: ['core'] },
  },
  {
    name: 'not-to-dev-dependency',
    severity: 'error',
    comment: 'Production code never imports a devDependency.',
    from: { path: '^(packages|apps)/[^/]+/src/' },
    to: { dependencyTypes: ['npm-dev'] },
  },
]

export const options = {
  doNotFollow: { path: 'node_modules' },
  exclude: { path: '(^|/)(node_modules|dist|\\.turbo)/' },
  tsPreCompilationDeps: true,
  combinedDependencies: false,
  enhancedResolveOptions: {
    conditionNames: ['@exponetdb/source', 'import', 'types', 'default'],
    exportsFields: ['exports'],
    extensions: ['.ts', '.js', '.mjs', '.json'],
  },
}

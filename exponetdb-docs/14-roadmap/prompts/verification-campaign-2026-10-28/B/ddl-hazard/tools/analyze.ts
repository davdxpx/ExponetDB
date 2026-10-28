/**
 * Runs the product's own analysis over a fixture project and prints, per
 * bundle, what lint, the plan-time analysis and the production policy say.
 *
 *   EXDB_TREE=<tree> bun --conditions=@exponetdb/source analyze.ts <project-dir> \
 *       [--profile strict|standard] [--mode offline|plan-large|plan-small] \
 *       [--major 16|17|18] [--no-covers] [--out file.json]
 *
 * - `offline`: exactly what `exponetdb migration lint` does (no table sizes).
 * - `plan-large` / `plan-small`: the lint context the server's planner builds
 *   (packages/migrations-engine/src/planner.ts: tier prod, catalog = live
 *   relation sizes, NO provenNotNull, NO extensionObjects) with `orders` at
 *   10 million rows / 1.6 GB (large) or 1,000 rows / 80 kB (small).
 * - The analysis and policy parts reuse `migrationAnalysis` (engine) and the
 *   `MIGRATION_RULES` policy engine with the facts the planner derives.
 */
import { readFile, writeFile } from 'node:fs/promises'

const tree = process.env['EXDB_TREE'] ?? '/home/david/Development/ExponetDB-verify-b3'
const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
const dir = args[0]
if (dir === undefined || dir.startsWith('--')) throw new Error('usage: analyze.ts <project-dir> [options]')
const profile = flag('profile', 'strict') as 'strict' | 'standard'
const mode = flag('mode', 'offline') as 'offline' | 'plan-large' | 'plan-small'
const major = Number(flag('major', '17')) as 16 | 17 | 18
const noCovers = args.includes('--no-covers')
const outFile = flag('out', '')

const { lintBundles, prepareLint } = await import(`${tree}/packages/migrations/src/lint/index.ts`)
const { currentProject, readBundles } = await import(`${tree}/apps/cli/src/local/project.ts`)
const { migrationAnalysis } = await import(`${tree}/packages/migrations-engine/src/analysis.ts`)
const { MIGRATION_RULES, PolicyEngine, RuleRegistry } = await import(`${tree}/packages/policy/src/index.ts`)
const { fixedClock } = await import(`${tree}/packages/kernel/src/index.ts`)
const { COMPATIBILITY_ORDER, worstSeverity } = await import(`${tree}/packages/postgres/src/parser/index.ts`)

const original = console.error
console.error = () => undefined
await prepareLint(major)
console.error = original

const project = await currentProject(dir)
// LINT_RULES='{"unsafe_not_null":"info"}' lowers rules the way a project's `lint.rules` does.
const lowered = process.env['LINT_RULES'] === undefined ? {} : { lint: { rules: JSON.parse(process.env['LINT_RULES']) } }
const config = { ...project.config, lintProfile: profile, ...lowered }
const bundles = await readBundles(project)
const inputs = bundles.map((b: { input: { files: Map<string, Uint8Array> } }) => {
  if (noCovers) {
    const v = b.input.files.get('verify.sql')
    if (v !== undefined) {
      const text = new TextDecoder().decode(v).replace(/^-- covers:.*\n/gm, '')
      b.input.files.set('verify.sql', new TextEncoder().encode(text))
    }
  }
  return b.input
})

const LARGE = { bytes: 1_600_000_000, rows: 10_000_000 }
const SMALL = { bytes: 81_920, rows: 1000 }
const sizeOf = (key: string) => (mode === 'plan-large' && ['public.orders', 'public.order_items', 'public.events_2026_10', 'public.audit_log'].includes(key) ? LARGE : SMALL)
const relations = new Map<string, { relkind: string; bytes: number; rows: number }>()
for (const [key, relkind] of [
  ['public.customers', 'r'], ['public.orders', 'r'], ['public.order_items', 'r'], ['public.audit_log', 'r'],
  ['public.events', 'p'], ['public.events_2026_10', 'r'], ['public.events_2026_11', 'r'], ['public.order_totals', 'm'],
] as const) {
  relations.set(key, { relkind, ...sizeOf(key) })
}

const report = lintBundles(inputs, {
  major,
  project: config,
  tier: 'prod',
  baselines: [],
  ...(mode === 'offline' ? {} : { catalog: { source: 'live', observedAt: '2026-10-28T00:00:00Z', relations } }),
})

const engine = new PolicyEngine({
  registry: new RuleRegistry(MIGRATION_RULES),
  providers: [],
  codeVersion: '0.1.0+b3',
  clock: fixedClock(Date.UTC(2026, 9, 28)),
})

async function decide(facts: Record<string, unknown>) {
  const d = await engine.evaluate({
    request: {
      kind: 'migration.apply',
      principal: { kind: 'human', identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', client: 'cli' },
      subject: { tier: 'prod' },
      content: { facts },
    },
    settings: [],
  })
  return {
    decision: d.decision as string,
    failed: d.rules.filter((r: { result: string }) => r.result === 'fail').map((r: { id: string }) => r.id),
    requirements: d.requirements.map((r: { kind: string }) => r.kind),
  }
}

const rank = (c: string) => (c === 'unknown' ? 99 : COMPATIBILITY_ORDER.indexOf(c))
const rows = []
for (const b of report.bundles) {
  const name = b.name ?? b.directory
  const analysis = migrationAnalysis(b, { checks: [], resolution: null }, relations, ['public'], [])
  const blocking = b.findings.filter((f: { blocking: boolean }) => f.blocking).length
  const facts = {
    compatibility: b.compatibility.observed,
    lockSeverity: b.lockSeverity,
    nontransactional: b.transactional === false,
    blockingFindings: blocking,
    consumerCode: 0,
    requirementsUnmet: [],
    evidence: 'present',
    lineage: 'match',
    dependenciesVerified: true,
    legacyProject: false,
    executionRoleExceptions: 0,
    executionRoleParity: 'not_required',
    procedural: false,
    proceduralReasons: [],
  }
  rows.push({
    id: name.split('-')[0],
    name,
    transactional: b.transactional,
    declared: b.compatibility.declared,
    observed: b.compatibility.observed,
    flags: b.compatibility.flags,
    lockSeverity: b.lockSeverity,
    autocommitStatements: b.autocommitStatements,
    statements: analysis.statements.map((s: { kind: string; lock: unknown; rewrite: unknown; transactional: boolean; compatibility: string; coverage: string }) => ({
      kind: s.kind, lock: s.lock, rewrite: s.rewrite, transactional: s.transactional, compatibility: s.compatibility,
    })),
    rewriteRisk: analysis.rewriteRisk,
    findings: b.findings.map((f: { rule: string; level: string; blocking: boolean; factsUnavailable: boolean; message: string }) => ({
      rule: f.rule, level: f.level, blocking: f.blocking, factsUnavailable: f.factsUnavailable, message: f.message,
    })),
    policy: await decide(facts),
  })
}
void rank
void worstSeverity

const result = { profile, mode, major, noCovers, graphValid: report.graph.valid, bundles: rows }
// One bundle per line: the files stay small enough to commit and still diff well.
if (outFile !== '') {
  const { bundles, ...head } = result
  await writeFile(outFile, `${JSON.stringify(head).slice(0, -1)},"bundles":[\n${bundles.map((b) => JSON.stringify(b)).join(',\n')}\n]}\n`)
}

// Compact table on stdout.
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
console.log(`profile=${profile} mode=${mode} major=${major}${noCovers ? ' no-covers' : ''}`)
console.log(`${pad('id', 4)} ${pad('slug', 30)} ${pad('tx', 3)} ${pad('obs', 20)} ${pad('lock', 8)} ${pad('policy', 8)} findings`)
for (const r of rows) {
  const f = r.findings.map((x: { rule: string; level: string; blocking: boolean }) => `${x.rule}[${x.level[0]}${x.blocking ? '!' : ''}]`).join(' ')
  console.log(`${pad(r.id, 4)} ${pad(r.name.split('-').slice(1).join('-'), 30)} ${pad(r.transactional ? 'tx' : 'nt', 3)} ${pad(r.observed, 20)} ${pad(r.lockSeverity, 8)} ${pad(r.policy.decision, 8)} ${f}`)
}
await readFile(`${dir}/exponetdb.project.yaml`)

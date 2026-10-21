import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { newUlid } from '@exponetdb/kernel'
import { type ValidatedBundle, validateBundle } from '@exponetdb/migrations/format'
import { buildGraph } from '@exponetdb/migrations/graph'
import { type LintFinding, lintBundles, type Tier } from '@exponetdb/migrations/lint'
import type { ImportReport, MigrationStatus, PlanView } from '@exponetdb/sdk'
import { applyPlan, planResult } from '../cli/apply.ts'
import { EXIT } from '../cli/exit.ts'
import { bodyFromFile, checkedBody } from '../cli/planning.ts'
import { arg, flag, showCommand, TARGET_FLAG } from '../cli/reads.ts'
import { must } from '../cli/remote.ts'
import type { CommandInput, CommandSpec, FlagSpec, RunContext } from '../cli/types.ts'
import { UsageError } from '../cli/usage.ts'
import { WAIT_FLAGS, waits, watchOperation } from '../cli/watch.ts'
import { CliError } from '../errors.ts'
import { loadGrammar } from '../local/grammar.ts'
import {
  bundleRoots,
  currentProject,
  type LocalBundle,
  type LocalProject,
  readBundles,
} from '../local/project.ts'
import { ago, dash, header } from '../output/format.ts'
import { type Block, type CommandResult, result } from '../output/model.ts'

/**
 * Migrations ([`04-migrations/`](../../../../exponetdb-docs/04-migrations/README.md)):
 * authoring, lint, checksums and the graph run locally with the same pure
 * packages the server uses (no server, no database); status, plans,
 * applies, verifications, imports, resumes and rollbacks go through the
 * server, which decides everything. An apply exits 0 only when every
 * migration is applied and verified; a rollback or resume is always an
 * explicit new plan, never automatic.
 */
const READ = ['migrations.read']
const PLAN = ['migrations.plan']

const TARGET_REQUIRED: FlagSpec = { ...TARGET_FLAG, required: true }

const workdir = (ctx: RunContext) => ctx.global.workdir ?? ctx.io.cwd

// ----- local -----

interface Validated {
  readonly bundle: LocalBundle
  readonly validated: ValidatedBundle | undefined
  readonly error: string | undefined
}

function validateAll(bundles: readonly LocalBundle[]): Validated[] {
  return bundles.map((bundle) => {
    const r = validateBundle(bundle.input)
    if (r.ok) return { bundle, validated: r.value, error: undefined }
    const e = r.error
    return {
      bundle,
      validated: undefined,
      error:
        e.code === 'MIGRATION_BUNDLE_INVALID'
          ? `${e.code}: ${e.details.reason}${e.details.file === undefined ? '' : ` (${e.details.file})`}`
          : `${e.code}: ${e.details.errors.map((x) => `${x.path} ${x.message}`).join('; ')}`,
    }
  })
}

function graphOf(valid: readonly ValidatedBundle[], baselines: readonly string[]) {
  return buildGraph({
    migrations: valid.map((v) => ({ id: v.manifest.id, dependsOn: v.manifest.dependsOn })),
    baselines,
  })
}

const baselinesOf = (project: LocalProject) =>
  project.config.legacy === undefined ? [] : [project.config.legacy.baseline]

function findingRow(f: LintFinding): string[] {
  const where = [f.file, f.line === null ? null : `line ${f.line}`]
    .filter((x) => x !== null)
    .join(' ')
  return [f.level, f.rule, dash(f.migrationId), where || '-', f.message]
}

const local = (spec: Omit<CommandSpec, 'locality' | 'effect' | 'group'>): CommandSpec => ({
  ...spec,
  group: 'migration',
  locality: 'local',
  effect: 'local',
})

const localCommands: readonly CommandSpec[] = [
  local({
    path: ['migration', 'new'],
    summary:
      'Create a new bundle directory (<ULID>_<name>) with migration.yaml, up.sql and verify.sql.',
    description:
      'Depends on the current heads of the stream unless --depends-on names others. Nothing existing is changed; the ULID is the identity, never the order.',
    args: [
      {
        name: 'name',
        description: 'Lowercase words joined by dashes, e.g. add-leads-index.',
        required: true,
      },
    ],
    flags: [
      {
        name: 'depends-on',
        type: 'list',
        placeholder: 'ids',
        description: 'Migration ids (or baseline refs) it depends on.',
      },
      {
        name: 'nontransactional',
        type: 'boolean',
        description: 'For statements that cannot run in a transaction (CREATE INDEX CONCURRENTLY).',
      },
      {
        name: 'root',
        type: 'string',
        placeholder: 'dir',
        description: 'Which bundle root (default the first).',
      },
    ],
    output: 'NewBundle',
    examples: [
      'exponetdb migration new add-leads-index',
      'exponetdb migration new leads-idx --nontransactional',
    ],
    async run(ctx, input) {
      const name = arg(input, 'name')
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
        throw new UsageError(
          'The name is lowercase letters and digits joined by dashes (at most 64).',
        )
      }
      const project = await currentProject(workdir(ctx))
      const roots = bundleRoots(project)
      const wanted = flag(input, 'root')
      const root =
        wanted === undefined ? roots[0] : roots.find((r) => relative(project.root, r) === wanted)
      if (root === undefined) throw new UsageError(`${wanted} is not a bundle root of the project.`)
      let dependsOn = input.flags['depends-on'] as string[] | undefined
      if (dependsOn === undefined) {
        const valid = validateAll(await readBundles(project)).flatMap((v) =>
          v.validated === undefined ? [] : [v.validated],
        )
        const graph = graphOf(valid, baselinesOf(project))
        dependsOn = graph.ok ? [...graph.value.heads()] : []
      }
      const id = newUlid(ctx.io.now())
      const directory = `${id}_${name}`
      const path = join(root, directory)
      await mkdir(path, { recursive: false, mode: 0o755 }).catch(() => {
        throw new CliError('file_refused', `${path} cannot be created (it may exist).`)
      })
      const transactional = input.flags['nontransactional'] !== true
      const manifest = [
        'schema: exponetdb.migration/v1',
        `id: ${id}`,
        `name: ${name}`,
        'description: |',
        '  What this migration changes and why.',
        ...(dependsOn.length === 0
          ? ['dependsOn: []']
          : ['dependsOn:', ...dependsOn.map((d) => `  - ${d}`)]),
        'execution:',
        `  transactional: ${transactional}`,
        'compatibility:',
        '  declared: additive',
        'verification:',
        '  expectations: auto',
        '  runtimeChecks: verify.sql',
        '',
      ].join('\n')
      await writeFile(join(path, 'migration.yaml'), manifest, { flag: 'wx' })
      await writeFile(
        join(path, 'up.sql'),
        '-- The change. One statement per line ends with a semicolon.\n',
        { flag: 'wx' },
      )
      await writeFile(
        join(path, 'verify.sql'),
        '-- check: describe what must hold after the change\nSELECT true AS ok;\n',
        { flag: 'wx' },
      )
      return result({
        command: 'migration new',
        data: { migrationId: id, directory, path, dependsOn, transactional },
        blocks: [
          {
            kind: 'fields',
            rows: [
              ['Migration', id],
              ['Directory', path],
              ['Depends on', dependsOn.join(', ') || '-'],
              ['Mode', transactional ? 'transactional' : 'nontransactional'],
            ],
          },
        ],
        next: ['exponetdb migration lint'],
      })
    },
  }),
  local({
    path: ['migration', 'lint'],
    summary:
      'Lint the local bundles with the PostgreSQL parser (offline facts; exit 1 on a blocking finding).',
    flags: [
      {
        name: 'postgres',
        type: 'enum',
        values: ['16', '17', '18'],
        description: 'The grammar (default 17).',
        default: '17',
      },
      {
        name: 'tier',
        type: 'enum',
        values: ['prod', 'nonprod'],
        description: 'Lint as for this tier (default prod, the strictest).',
        default: 'prod',
      },
    ],
    output: 'LintReport',
    async run(ctx, input) {
      const project = await currentProject(workdir(ctx))
      const bundles = await readBundles(project)
      const major = Number(input.flags['postgres'] ?? 17) as 16 | 17 | 18
      await loadGrammar(major)
      const report = lintBundles(
        bundles.map((b) => b.input),
        {
          major,
          project: project.config,
          tier: String(input.flags['tier'] ?? 'prod') as Tier,
          baselines: baselinesOf(project),
        },
      )
      const findings = [...report.findings, ...report.bundles.flatMap((b) => b.findings)]
      const blocking = findings.filter((f) => f.blocking)
      return result({
        command: 'migration lint',
        status: blocking.length === 0 ? 'ok' : 'failed',
        exitCode: blocking.length === 0 ? EXIT.ok : EXIT.failure,
        data: {
          major: report.major,
          tier: report.tier,
          facts: report.facts,
          bundles: report.bundles.map((b) => ({
            directory: b.directory,
            migrationId: b.migrationId,
            valid: b.valid,
            checksum: b.checksum,
            findings: b.findings,
          })),
          graph: report.graph,
          findings: report.findings,
        },
        ...(blocking.length === 0
          ? {}
          : {
              error: {
                code: 'MIGRATION_LINT_BLOCKED',
                message: `${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'}.`,
              },
            }),
        blocks: [
          {
            kind: 'text',
            tone: 'muted',
            lines: [
              `${report.bundles.length} bundles · PostgreSQL ${report.major} grammar · ${report.tier} rules · offline facts`,
            ],
          },
          {
            kind: 'table',
            columns: [
              { title: 'LEVEL' },
              { title: 'RULE' },
              { title: 'MIGRATION' },
              { title: 'WHERE' },
              { title: 'MESSAGE', flexible: true },
            ],
            rows: findings.map(findingRow),
            empty: 'No findings.',
          },
          {
            kind: 'status',
            word: blocking.length === 0 ? 'OK' : 'BLOCKED',
            tone: blocking.length === 0 ? 'ok' : 'error',
            text: `${findings.length} findings, ${blocking.length} blocking`,
          },
        ],
      })
    },
  }),
  local({
    path: ['migration', 'checksum'],
    summary:
      'The apply checksum and digests of each local bundle (sha256:c1:…), as the server computes them.',
    output: 'ChecksumList',
    async run(ctx) {
      const project = await currentProject(workdir(ctx))
      const all = validateAll(await readBundles(project))
      const items = all.map((v) =>
        v.validated === undefined
          ? { directory: v.bundle.directory, valid: false, error: v.error }
          : {
              directory: v.bundle.directory,
              valid: true,
              migrationId: v.validated.manifest.id,
              checksum: v.validated.digests.checksum,
              verifyDigest: v.validated.digests.verifyDigest,
              rollbackDigest: v.validated.digests.rollbackDigest,
              bundleDigest: v.validated.digests.bundleDigest,
            },
      )
      const invalid = items.filter((i) => !i.valid).length
      return result({
        command: 'migration checksum',
        status: invalid === 0 ? 'ok' : 'failed',
        exitCode: invalid === 0 ? EXIT.ok : EXIT.failure,
        items,
        ...(invalid === 0
          ? {}
          : {
              error: {
                code: 'MIGRATION_BUNDLE_INVALID',
                message: `${invalid} bundle${invalid === 1 ? ' is' : 's are'} not valid.`,
              },
            }),
        blocks: [
          {
            kind: 'table',
            columns: [{ title: 'BUNDLE', flexible: true }, { title: 'APPLY CHECKSUM' }],
            rows: items.map((i) => [
              i.directory,
              'checksum' in i ? String(i.checksum) : `invalid: ${i.error}`,
            ]),
            empty: 'No bundles.',
          },
        ],
      })
    },
  }),
  local({
    path: ['migration', 'graph'],
    summary: 'The dependency graph of the local stream: order, heads and errors (no server).',
    output: 'MigrationGraph',
    async run(ctx) {
      const project = await currentProject(workdir(ctx))
      const all = validateAll(await readBundles(project))
      const valid = all.flatMap((v) => (v.validated === undefined ? [] : [v.validated]))
      const graph = graphOf(valid, baselinesOf(project))
      const names = new Map<string, string>(valid.map((v) => [v.manifest.id, v.manifest.name]))
      if (!graph.ok) {
        return result({
          command: 'migration graph',
          status: 'failed',
          exitCode: EXIT.failure,
          data: { valid: false, error: graph.error },
          error: {
            code: 'MIGRATION_DEPENDENCY_CYCLE',
            message: `The graph is not valid: ${JSON.stringify(graph.error)}`,
          },
        })
      }
      const order = [...graph.value.order()]
      const heads = [...graph.value.heads()]
      return result({
        command: 'migration graph',
        data: {
          valid: true,
          order,
          heads,
          invalidBundles: all.filter((v) => v.error !== undefined).map((v) => v.bundle.directory),
        },
        blocks: [
          {
            kind: 'table',
            columns: [
              { title: '#', align: 'right' },
              { title: 'MIGRATION' },
              { title: 'NAME', flexible: true },
              { title: 'HEAD' },
            ],
            rows: order.map((id, i) => [
              String(i + 1),
              id,
              names.get(id) ?? '(baseline)',
              heads.includes(id) ? 'yes' : '',
            ]),
            empty: 'No migrations.',
          },
        ],
      })
    },
  }),
]

// ----- remote -----

function statusBlocks(s: MigrationStatus, now: number): Block[] {
  return [
    {
      kind: 'fields',
      rows: [
        ['Target', s.targetId],
        [
          'Ledger',
          `${s.applied.length} applied · ${s.pending.length} pending (${s.source}, ${ago(s.observedAt, now)})`,
        ],
        ['Baseline', s.baselineId],
        [
          'Mirror',
          s.mirror.inSync ? 'in sync' : `out of sync (checked ${ago(s.mirror.checkedAt, now)})`,
        ],
        ...((s.incompleteNontransactional ?? []).length > 0
          ? [['Incomplete', (s.incompleteNontransactional ?? []).join(', ')] as [string, string]]
          : []),
      ],
    },
    {
      kind: 'table',
      columns: [
        { title: 'MIGRATION' },
        { title: 'NAME', flexible: true },
        { title: 'STATE' },
        { title: 'VERIFIED' },
        { title: 'ORIGIN' },
        { title: 'APPLIED' },
      ],
      rows: [
        ...s.applied.map((e) => [
          e.migrationId,
          e.name,
          e.reverted ? 'reverted' : 'applied',
          e.verification.status,
          e.origin,
          ago(e.appliedAt, now),
        ]),
        ...s.pending.map((p) => [p.migrationId, p.name, 'pending', '-', '-', '-']),
      ],
      empty: 'No migrations recorded or pending.',
    },
  ]
}

/** The local bundles to submit: the named ids, or every local bundle (the server plans the pending ones). */
async function submissions(ctx: RunContext, ids: readonly string[]) {
  const project = await currentProject(workdir(ctx))
  const bundles = await readBundles(project)
  const chosen =
    ids.length === 0
      ? bundles
      : bundles.filter((b) => ids.some((id) => b.directory.startsWith(`${id}_`)))
  if (ids.length > 0 && chosen.length !== ids.length) {
    throw new UsageError(`Not every named migration is a local bundle: ${ids.join(', ')}.`)
  }
  const missing = chosen.filter((b) => b.submission === undefined)
  if (missing.length > 0) {
    throw new CliError(
      'MIGRATION_BUNDLE_INVALID',
      `Not valid UTF-8 or missing files: ${missing.map((b) => b.directory).join(', ')}.`,
    )
  }
  return {
    project,
    bundles: chosen.flatMap((b) => (b.submission === undefined ? [] : [b.submission])),
  }
}

async function planMigrations(
  ctx: RunContext,
  input: CommandInput,
): Promise<{ plan: PlanView; command: string }> {
  const ids = (input.args['migration'] as readonly string[] | undefined) ?? []
  const fromServer = input.flags['stored'] === true
  const remote = await ctx.remote()
  let body: Record<string, unknown>
  if (fromServer) {
    if (ids.length === 0) throw new UsageError('--stored needs the migration ids to plan.')
    body = { migrationIds: ids }
  } else {
    const { project, bundles } = await submissions(ctx, ids)
    body = {
      bundles,
      ...(project.config.defaults === undefined ? {} : { defaults: project.config.defaults }),
      ...(project.config.lint === undefined ? {} : { lint: project.config.lint }),
      ...(project.config.invariants === undefined ? {} : { invariants: project.config.invariants }),
      lintProfile: project.config.lintProfile,
    }
  }
  const grant = flag(input, 'break-glass')
  if (grant !== undefined) body['breakGlassGrantId'] = grant
  const checked = checkedBody('planMigrations', body)
  const plan = must(
    await remote.sdk.call('planMigrations', {
      params: { target: String(input.flags['target']) },
      body: checked as never,
    }),
  )
  return { plan, command: '' }
}

const PLAN_FLAGS: readonly FlagSpec[] = [
  TARGET_REQUIRED,
  {
    name: 'stored',
    type: 'boolean',
    description: 'Plan bundles already ingested on the server (by id) instead of the local ones.',
  },
  {
    name: 'break-glass',
    type: 'string',
    placeholder: 'bgl_…',
    description: 'Plan under an active break-glass grant of yours.',
  },
]

/** The import hints a `--hints` file may carry (the request contract checks their shapes). */
const HINT_FIELDS = ['aliases', 'notApplicable', 'role', 'searchPath', 'ledgers'] as const

/**
 * `--baseline` and the project file's `legacy.baseline` name the baseline as
 * `baseline:<slug>` (the dependency ref of the migration format) or as the
 * bare slug; the REST request takes the slug. Anything else is left for the
 * contract check to refuse.
 */
export function baselineSlug(value: string): string {
  return value.startsWith('baseline:') ? value.slice('baseline:'.length) : value
}

/**
 * The hints of a legacy import from a JSON or YAML file (data only, at most
 * 256 KiB): an object with only the fields of {@link HINT_FIELDS}. A field
 * given both in the file and as a flag is refused, never silently merged.
 */
export async function importHints(
  ctx: RunContext,
  path: string,
  flags: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const value = await bodyFromFile(ctx, path)
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new UsageError(`The hints file ${path} must hold one object.`)
  const hints = value as Record<string, unknown>
  const unknown = Object.keys(hints).filter((k) => !(HINT_FIELDS as readonly string[]).includes(k))
  if (unknown.length > 0)
    throw new UsageError(
      `The hints file ${path} has fields the import does not know: ${unknown.slice(0, 5).join(', ')} (allowed: ${HINT_FIELDS.join(', ')}).`,
    )
  const twice = (
    [
      ['ledgers', 'ledger'],
      ['notApplicable', 'not-applicable'],
    ] as const
  ).filter(([field, name]) => field in hints && flags[name] !== undefined)
  if (twice.length > 0)
    throw new UsageError(
      `Give ${twice.map(([field, name]) => `${field} (--${name})`).join(' and ')} either in the hints file or as a flag, not both.`,
    )
  return hints
}

function reportBlocks(r: ImportReport): Block[] {
  return [
    {
      kind: 'fields',
      rows: [
        ['Report', r.id],
        ['Target', r.targetId],
        ['State', r.state],
        ['Baseline', r.baselineId],
        ['Unresolved', String(r.unresolved)],
        ['Fingerprint', r.fingerprint],
        ['Replay', r.replayFingerprint ?? null],
        ...(r.incompleteReason === undefined || r.incompleteReason === null
          ? []
          : [['Incomplete', r.incompleteReason] as [string, string]]),
      ],
    },
    {
      kind: 'table',
      columns: [
        { title: 'ITEM' },
        { title: 'LEGACY' },
        { title: 'NAME', flexible: true },
        { title: 'STATE' },
        { title: 'DECISION' },
      ],
      rows: r.items.map((i) => [i.itemId, i.legacyId, i.name, i.state, i.decision?.state ?? '-']),
      empty: 'No items.',
    },
  ]
}

const remoteCommands: readonly CommandSpec[] = [
  showCommand({
    path: ['migration', 'status'],
    summary: 'The target’s ledger, read live: applied (with verification) and pending migrations.',
    aliases: [['migration', 'list']],
    group: 'migration',
    flags: [TARGET_REQUIRED],
    action: 'migration.status.get',
    scopes: READ,
    output: 'MigrationStatus',
    title: 'migrations',
    operation: 'getTargetMigrations',
    params: (i) => ({ target: String(i.flags['target']) }),
    view: statusBlocks,
    next: (s) => (s.pending.length > 0 ? [`exponetdb migration plan --target ${s.targetId}`] : []),
  }),
  showCommand({
    path: ['migration', 'show'],
    summary: 'One migration on a target: state, events, verification runs.',
    group: 'migration',
    args: [{ name: 'migration', description: 'The migration id (ULID).', required: true }],
    flags: [TARGET_REQUIRED],
    action: 'migration.get',
    scopes: READ,
    output: 'MigrationDetail',
    title: 'migration',
    operation: 'getTargetMigration',
    params: (i) => ({ target: String(i.flags['target']), migrationId: arg(i, 'migration') }),
    view: (d, now) => [
      {
        kind: 'fields',
        rows: [
          ['Migration', d.migrationId],
          ['State', d.state],
          ['Checksum', d.checksum],
          ['Applied', d.appliedAt],
          ['Operation', d.operationId],
          ['Plan', d.planId],
          ['Read', `${d.source}, ${ago(d.observedAt, now)}`],
        ],
      },
      {
        kind: 'table',
        columns: [
          { title: 'EVENT' },
          { title: 'AT' },
          { title: 'STATEMENT', align: 'right' },
          { title: 'SQLSTATE' },
        ],
        rows: d.events.map((e) => [
          e.event,
          e.at,
          e.statementIndex === null ? '-' : String(e.statementIndex),
          dash(e.sqlstate),
        ]),
        empty: 'No events.',
      },
      {
        kind: 'table',
        columns: [
          { title: 'VERIFICATION' },
          { title: 'STATUS' },
          { title: 'STRUCTURAL' },
          { title: 'RUNTIME' },
          { title: 'FINISHED' },
        ],
        rows: d.verifications.map((v) => [
          v.verificationId,
          v.status,
          v.structural.status,
          v.runtime.status,
          v.finishedAt,
        ]),
        empty: 'Not verified.',
      },
    ],
  }),
  showCommand({
    path: ['migration', 'evidence'],
    summary:
      'The verification evidence of a migration on a target (what production promotion binds).',
    group: 'migration',
    args: [{ name: 'migration', description: 'The migration id.', required: true }],
    flags: [TARGET_REQUIRED],
    action: 'migration.get',
    scopes: READ,
    output: 'MigrationDetail',
    title: 'evidence',
    operation: 'getTargetMigration',
    params: (i) => ({ target: String(i.flags['target']), migrationId: arg(i, 'migration') }),
    view: (d) => [
      {
        kind: 'table',
        columns: [
          { title: 'RUN' },
          { title: 'STATUS' },
          { title: 'VERIFY DIGEST', flexible: true },
          { title: 'FINGERPRINT', flexible: true },
          { title: 'FIRST FAILURE', flexible: true },
        ],
        rows: d.verifications.map((v) => [
          v.verificationId,
          v.status,
          dash(v.verifyDigest),
          v.fingerprint,
          v.structural.firstFailure?.name ?? v.runtime.firstFailure?.name ?? '-',
        ]),
        empty:
          'No verification run: production promotion needs one that passed with the same checksum.',
      },
    ],
  }),
  {
    path: ['migration', 'plan'],
    summary:
      'Plan migrations for a target from the local bundles (or stored ones): analysis, policy, evidence.',
    description:
      'Submits the exact bytes of the local bundles; the server ingests them, analyzes them against the live target and decides. Nothing runs until plan apply.',
    group: 'migration',
    args: [
      {
        name: 'migration',
        description: 'Migration ids to plan (default: what is pending).',
        variadic: true,
      },
    ],
    flags: PLAN_FLAGS,
    locality: 'remote',
    effect: 'plan',
    action: 'migration.plan',
    scopes: PLAN,
    output: 'PlanView',
    examples: [
      'exponetdb migration plan --target demo/platform/staging',
      'exponetdb migration plan 01HV… --target demo/platform/production',
    ],
    async run(ctx, input) {
      const { plan } = await planMigrations(ctx, input)
      return planResult('migration plan', await ctx.remote(), plan)
    },
  },
  {
    path: ['migration', 'apply'],
    summary: 'Plan and apply migrations, then wait until applied and verified (exit 0 only then).',
    group: 'migration',
    args: [
      {
        name: 'migration',
        description: 'Migration ids (default: what is pending).',
        variadic: true,
      },
    ],
    flags: [
      ...PLAN_FLAGS,
      ...WAIT_FLAGS,
      {
        name: 'step-up',
        type: 'string',
        placeholder: 'stu_…',
        description: 'A step-up confirmed for the plan.',
      },
    ],
    locality: 'remote',
    effect: 'mutation',
    action: 'migration.apply',
    scopes: ['migrations.plan', 'migrations.apply:nonprod'],
    output: 'Operation',
    examples: ['exponetdb migration apply --target demo/platform/staging'],
    async run(ctx, input) {
      const { plan } = await planMigrations(ctx, input)
      const remote = await ctx.remote()
      if (plan.decision === 'deny') return planResult('migration apply', remote, plan)
      return applyPlan(ctx, remote, 'migration apply', plan, input.flags)
    },
  },
  {
    path: ['migration', 'verify'],
    summary: 'Run a migration’s verification again on a target and wait for its result.',
    group: 'migration',
    args: [{ name: 'migration', description: 'The migration id.', required: true }],
    flags: [
      TARGET_REQUIRED,
      {
        name: 'revision',
        type: 'number',
        description: 'The bundle revision whose verify.sql runs.',
      },
      ...WAIT_FLAGS,
    ],
    locality: 'remote',
    effect: 'mutation',
    action: 'migration.verify',
    scopes: READ,
    output: 'Operation',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const op = must(
        await remote.sdk.call('verifyMigration', {
          params: { target: String(input.flags['target']), migrationId: arg(input, 'migration') },
          body:
            typeof input.flags['revision'] === 'number'
              ? { revision: input.flags['revision'] }
              : {},
        }),
      )
      if (!waits(input.flags)) return watchOperation(ctx, remote, 'migration verify', op, 0)
      return watchOperation(
        ctx,
        remote,
        'migration verify',
        op,
        Number(input.flags['timeout-wait'] ?? 900_000),
      )
    },
  },
  ...(['resume', 'rollback'] as const).map(
    (verb): CommandSpec => ({
      path: ['migration', verb],
      summary:
        verb === 'resume'
          ? 'Plan resuming a non-transactional migration that stopped part-way (an explicit new plan).'
          : 'Plan rolling back the latest migration with its down.sql (an explicit new plan; never automatic).',
      group: 'migration',
      args: [{ name: 'migration', description: 'The migration id.', required: true }],
      flags: [
        TARGET_REQUIRED,
        ...(verb === 'resume'
          ? [
              {
                name: 'cleanup',
                type: 'boolean',
                description: 'Drop the INVALID index the stopped statement left (by its OID).',
              } as FlagSpec,
            ]
          : []),
        { name: 'apply', type: 'boolean', description: 'Apply the plan at once and wait.' },
        ...WAIT_FLAGS,
      ],
      locality: 'remote',
      effect: 'plan',
      action: verb === 'resume' ? 'migration.resume.plan' : 'migration.rollback.plan',
      scopes: PLAN,
      output: 'PlanView',
      async run(ctx, input) {
        const remote = await ctx.remote()
        const params = {
          target: String(input.flags['target']),
          migrationId: arg(input, 'migration'),
        }
        const plan =
          verb === 'resume'
            ? must(
                await remote.sdk.call('planMigrationResume', {
                  params,
                  body: input.flags['cleanup'] === true ? { cleanup: true } : {},
                }),
              )
            : must(await remote.sdk.call('planMigrationRollback', { params, body: {} }))
        const name = `migration ${verb}`
        if (input.flags['apply'] !== true || plan.decision === 'deny')
          return planResult(name, remote, plan)
        return applyPlan(ctx, remote, name, plan, input.flags)
      },
    }),
  ),
  {
    path: ['migration', 'import', 'analyze'],
    summary:
      'Plan a legacy import analysis: replay the legacy files on a scratch target and classify them.',
    group: 'migration',
    flags: [
      TARGET_REQUIRED,
      {
        name: 'scratch',
        type: 'string',
        placeholder: 'target',
        description: 'An empty disposable target to replay on.',
        required: true,
      },
      {
        name: 'baseline',
        type: 'string',
        placeholder: 'slug',
        description: 'The baseline, as baseline:<slug> or <slug> (default the project’s).',
      },
      {
        name: 'hints',
        type: 'string',
        placeholder: 'path',
        description:
          'Import hints as a JSON or YAML file: aliases, notApplicable, role, searchPath, ledgers (checked against the contract).',
      },
      {
        name: 'ledger',
        type: 'list',
        placeholder: 'supabase,drizzle,applied_migrations',
        description: 'Legacy ledgers to read.',
      },
      {
        name: 'not-applicable',
        type: 'list',
        placeholder: 'files',
        description: 'Legacy files that never apply to this target.',
      },
      { name: 'apply', type: 'boolean', description: 'Apply the analysis plan at once and wait.' },
      ...WAIT_FLAGS,
    ],
    locality: 'remote',
    effect: 'plan',
    action: 'migration.import.analyze',
    scopes: ['migrations.import'],
    output: 'PlanView',
    async run(ctx, input) {
      const project = await currentProject(workdir(ctx))
      const legacy = project.config.legacy
      if (legacy === undefined)
        throw new UsageError('The project has no legacy directory (layout legacy+bundles).')
      const { readdir, readFile } = await import('node:fs/promises')
      const dir = join(project.root, legacy.directory)
      const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()
      const files = []
      for (const name of names) files.push({ name, text: await readFile(join(dir, name), 'utf8') })
      const hintsPath = flag(input, 'hints')
      const hints = hintsPath === undefined ? {} : await importHints(ctx, hintsPath, input.flags)
      const body = checkedBody('planImportAnalysis', {
        ...hints,
        scratchTarget: flag(input, 'scratch'),
        baseline: baselineSlug(flag(input, 'baseline') ?? legacy.baseline),
        files,
        ...(input.flags['ledger'] === undefined ? {} : { ledgers: input.flags['ledger'] }),
        ...(input.flags['not-applicable'] === undefined
          ? {}
          : { notApplicable: input.flags['not-applicable'] }),
      })
      const remote = await ctx.remote()
      const plan = must(
        await remote.sdk.call('planImportAnalysis', {
          params: { target: String(input.flags['target']) },
          body: body as never,
        }),
      )
      if (input.flags['apply'] !== true || plan.decision === 'deny')
        return planResult('migration import analyze', remote, plan)
      return applyPlan(ctx, remote, 'migration import analyze', plan, input.flags)
    },
  },
  showCommand({
    path: ['migration', 'import', 'report'],
    summary: 'An import report: every legacy file’s classification and the decisions so far.',
    group: 'migration',
    args: [{ name: 'report', description: 'The import report id.', required: true }],
    flags: [TARGET_REQUIRED],
    action: 'migration.import.report.get',
    scopes: ['migrations.import'],
    output: 'ImportReport',
    title: 'import report',
    operation: 'getImportReport',
    params: (i) => ({ target: String(i.flags['target']), importReportId: arg(i, 'report') }),
    view: (r) => reportBlocks(r),
    next: (r) =>
      r.state === 'resolved'
        ? [`exponetdb migration import baseline ${r.id} --target ${r.targetId}`]
        : r.unresolved > 0
          ? [
              `exponetdb migration import resolve ${r.id} <item> --target ${r.targetId} --state … --note …`,
            ]
          : [],
  }),
  {
    path: ['migration', 'import', 'resolve'],
    summary: 'Record your decision for one item of an import report (with a note).',
    group: 'migration',
    args: [
      { name: 'report', description: 'The import report id.', required: true },
      { name: 'item', description: 'The item id.', required: true },
    ],
    flags: [
      TARGET_REQUIRED,
      {
        name: 'state',
        type: 'enum',
        values: [
          'recorded_present',
          'unrecorded_present',
          'recorded_missing',
          'unrecorded_missing',
          'superseded',
          'not_applicable',
        ],
        description: 'What the item is.',
        required: true,
      },
      {
        name: 'note',
        type: 'string',
        placeholder: 'text',
        description: 'Why (kept with the decision).',
        required: true,
      },
    ],
    locality: 'remote',
    effect: 'mutation',
    action: 'migration.import.decide',
    scopes: ['migrations.import'],
    output: 'ImportReport',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const r = must(
        await remote.sdk.call('decideImportItem', {
          params: {
            target: String(input.flags['target']),
            importReportId: arg(input, 'report'),
            itemId: arg(input, 'item'),
          },
          body: { state: String(input.flags['state']) as never, note: String(input.flags['note']) },
        }),
      )
      return result({
        command: 'migration import resolve',
        data: r,
        blocks: [header('import report', remote.context), ...reportBlocks(r)],
      })
    },
  },
  {
    path: ['migration', 'import', 'baseline'],
    summary:
      'Plan the baseline of a resolved import report (records the legacy ledger; changes no schema).',
    group: 'migration',
    args: [{ name: 'report', description: 'The import report id.', required: true }],
    flags: [
      TARGET_REQUIRED,
      { name: 'apply', type: 'boolean', description: 'Apply at once and wait.' },
      ...WAIT_FLAGS,
    ],
    locality: 'remote',
    effect: 'plan',
    action: 'migration.baseline.plan',
    scopes: ['migrations.import'],
    output: 'PlanView',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const plan = must(
        await remote.sdk.call('planBaseline', {
          params: { target: String(input.flags['target']) },
          body: { importReportId: arg(input, 'report') },
        }),
      )
      if (input.flags['apply'] !== true || plan.decision === 'deny')
        return planResult('migration import baseline', remote, plan)
      return applyPlan(ctx, remote, 'migration import baseline', plan, input.flags)
    },
  },
]

export const migrationCommands: readonly CommandSpec[] = [...localCommands, ...remoteCommands]
export type { CommandResult }

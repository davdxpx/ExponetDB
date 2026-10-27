import { randomUUID } from 'node:crypto'
import { ADVISOR_CATEGORIES } from '@exponetdb/contracts'
import { EXIT } from '../cli/exit.ts'
import { checkedBody, planCommand } from '../cli/planning.ts'
import { arg, flag, listCommand, showCommand, TARGET_FLAG } from '../cli/reads.ts'
import { must } from '../cli/remote.ts'
import type { CommandInput, CommandSpec, FlagSpec } from '../cli/types.ts'
import { UsageError } from '../cli/usage.ts'
import { inlineResult, WAIT_FLAGS } from '../cli/watch.ts'
import { ago, dash, header } from '../output/format.ts'
import { type Block, result } from '../output/model.ts'
import { bytes } from './backup.ts'

/**
 * Diagnostics ([`10-observability/`](../../../../exponetdb-docs/10-observability/README.md)):
 * target health, findings, schema reads and drift checks, and since Wave 9
 * query and table statistics, live advisors, cluster findings and the
 * session actions (cancel a query inline, plan a termination). Every read
 * carries its source and time; a failed read is an error, never an empty
 * list. Statement text is redacted by the server and printed as data.
 */
const DIAG = ['diagnostics.read']
const SCHEMA = ['schema.read']
const CONNECTIONS = ['connections.operate:nonprod']

const TARGET_REQUIRED = { ...TARGET_FLAG, required: true }
const TARGET_ARG = { name: 'target', description: 'A target id or path.', required: true }
const PID_ARG = { name: 'pid', description: 'The backend process id.', required: true }
const BACKEND_START: FlagSpec = {
  name: 'backend-start',
  type: 'string',
  placeholder: 'time',
  description: 'The session’s backend start (RFC 3339, as `session list` shows it).',
  required: true,
}

/** A backend pid as the path takes it (a positive 32-bit integer). */
function pid(input: CommandInput): string {
  const v = arg(input, 'pid')
  if (!/^[1-9][0-9]{0,9}$/.test(v) || Number(v) > 2_147_483_647) {
    throw new UsageError('<pid> is a positive process id.')
  }
  return v
}

/** A short form of a sha256 digest for a table (the JSON output keeps it whole). */
const shortDigest = (d: string) => `${d.slice(0, 'sha256:'.length + 12)}…`

const ms = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(2))

export const diagnoseCommands: readonly CommandSpec[] = [
  showCommand({
    path: ['health'],
    summary: 'A target’s health: probes, conditions, node and backups, with source and time.',
    group: 'diagnose',
    args: [{ name: 'target', description: 'A target id or path.', required: true }],
    action: 'target.health.get',
    scopes: DIAG,
    output: 'TargetHealth',
    title: 'health',
    operation: 'getTargetHealth',
    params: (i) => ({ target: arg(i, 'target') }),
    view: (h, now) => [
      {
        kind: 'status',
        word: h.state,
        tone: h.state === 'healthy' ? 'ok' : h.state === 'unknown' ? 'warn' : 'error',
        text: `${h.source}, ${ago(h.observedAt, now)}${h.unknownBecause === null ? '' : ` (unknown because ${h.unknownBecause})`}`,
      },
      {
        kind: 'fields',
        rows: [
          ['Lifecycle', h.lifecycle],
          [
            'Node',
            h.node === null
              ? null
              : `${h.node.state} (${h.node.nodeId}, ${ago(h.node.observedAt, now)})`,
          ],
          [
            'Backups',
            h.backups === null ? null : `${h.backups.state} (${ago(h.backups.observedAt, now)})`,
          ],
        ],
      },
      {
        kind: 'table',
        columns: [
          { title: 'PROBE' },
          { title: 'ENDPOINT' },
          { title: 'OUTCOME' },
          { title: 'TLS' },
          { title: 'MS', align: 'right' },
        ],
        rows: h.probes.map((p) => [
          p.probe,
          p.endpoint.label,
          p.outcome,
          p.tls,
          p.durationMs === null ? '-' : String(p.durationMs),
        ]),
        empty: 'No probes yet.',
      },
      {
        kind: 'table',
        columns: [
          { title: 'CONDITION' },
          { title: 'SEVERITY' },
          { title: 'COUNT', align: 'right' },
          { title: 'OBSERVED' },
        ],
        rows: h.conditions.map((c) => [
          c.condition,
          c.severity,
          c.count === null ? '-' : String(c.count),
          ago(c.observedAt, now),
        ]),
        empty: 'No conditions.',
      },
    ],
  }),
  listCommand({
    path: ['finding', 'list'],
    summary:
      'Findings across the targets you may read (drift, health, advisors, statements), open by default.',
    description:
      'Without --target, the findings of every target you may read with diagnostics.read, newest first; --kind and --code narrow to one rule or condition.',
    group: 'diagnose',
    flags: [
      TARGET_FLAG,
      { name: 'include-resolved', type: 'boolean', description: 'Also resolved findings.' },
      {
        name: 'severity',
        type: 'enum',
        values: ['info', 'warning', 'critical'],
        description: 'Only this severity.',
      },
      {
        name: 'kind',
        type: 'enum',
        values: ['drift', 'health', 'advisor', 'statements'],
        description: 'Only this kind.',
      },
      {
        name: 'code',
        type: 'string',
        placeholder: 'code',
        description: 'Only this rule or condition code.',
      },
    ],
    action: 'finding.list',
    scopes: DIAG,
    output: 'FleetFindingList',
    title: 'findings',
    operation: 'listFindings',
    noun: 'finding',
    query: (i) => ({
      ...(flag(i, 'target') === undefined ? {} : { target: flag(i, 'target') }),
      ...(i.flags['include-resolved'] === true ? { state: 'all' } : {}),
      ...(i.flags['severity'] === undefined ? {} : { severity: i.flags['severity'] }),
      ...(i.flags['kind'] === undefined ? {} : { kind: i.flags['kind'] }),
      ...(flag(i, 'code') === undefined ? {} : { code: flag(i, 'code') }),
    }),
    columns: [
      { title: 'FINDING' },
      { title: 'TARGET' },
      { title: 'SEVERITY' },
      { title: 'CODE' },
      { title: 'OBJECT' },
      { title: 'SUMMARY', flexible: true },
      { title: 'LAST SEEN' },
    ],
    row: (f, now) => [
      f.id,
      f.targetPath,
      f.severity,
      f.code,
      dash(f.object),
      f.summary,
      ago(f.lastSeenAt, now),
    ],
    empty: 'No findings.',
  }),
  showCommand({
    path: ['finding', 'summary'],
    summary: 'Counts of the open findings you may read, by severity, kind and code.',
    group: 'diagnose',
    action: 'finding.summary',
    scopes: DIAG,
    output: 'FindingSummary',
    title: 'finding summary',
    operation: 'getFindingSummary',
    params: () => ({}),
    view: (s, now) => [
      {
        kind: 'fields',
        rows: [
          ['Open', String(s.open)],
          [
            'By severity',
            `${s.bySeverity.critical} critical, ${s.bySeverity.warning} warning, ${s.bySeverity.info} info`,
          ],
          [
            'By kind',
            s.byKind.length === 0 ? '-' : s.byKind.map((k) => `${k.kind} ${k.count}`).join(', '),
          ],
          ['Read', `${s.source}, ${ago(s.observedAt, now)}`],
        ],
      },
      {
        kind: 'table',
        columns: [
          { title: 'KIND' },
          { title: 'CODE', flexible: true },
          { title: 'SEVERITY' },
          { title: 'COUNT', align: 'right' },
        ],
        rows: s.topCodes.map((c) => [c.kind, c.code, c.severity, String(c.count)]),
        empty: 'No open findings.',
      },
    ],
  }),
  listCommand({
    path: ['cluster', 'findings'],
    summary: 'Findings of a cluster (backups and other cluster-level findings), open by default.',
    group: 'diagnose',
    args: [{ name: 'cluster', description: 'A cluster id (cls_…).', required: true }],
    flags: [
      {
        name: 'state',
        type: 'enum',
        values: ['open', 'resolved', 'all'],
        description: 'Which findings (default open).',
      },
    ],
    action: 'cluster.finding.list',
    scopes: ['backups.read'],
    output: 'FindingList',
    title: 'cluster findings',
    operation: 'listClusterFindings',
    noun: 'finding',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    query: (i) => (i.flags['state'] === undefined ? {} : { state: i.flags['state'] }),
    columns: [
      { title: 'FINDING' },
      { title: 'KIND' },
      { title: 'SEVERITY' },
      { title: 'CODE' },
      { title: 'SUMMARY', flexible: true },
      { title: 'LAST SEEN' },
    ],
    row: (f, now) => [f.id, f.kind, f.severity, f.code, f.summary, ago(f.lastSeenAt, now)],
    empty: 'No findings.',
  }),
  {
    path: ['finding', 'show'],
    summary: 'One finding of a target.',
    group: 'diagnose',
    args: [{ name: 'finding', description: 'The finding id.', required: true }],
    flags: [TARGET_REQUIRED],
    locality: 'remote',
    effect: 'read',
    action: 'target.finding.list',
    scopes: DIAG,
    output: 'Finding',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const id = arg(input, 'finding')
      for await (const page of remote.sdk.pages(
        'listTargetFindings',
        { target: String(input.flags['target']) },
        { includeResolved: true } as never,
      )) {
        const f = must(page).items.find((x) => x.id === id)
        if (f !== undefined) {
          const now = ctx.io.now()
          return result({
            command: 'finding show',
            data: f,
            blocks: [
              header(`finding ${f.id}`, remote.context),
              {
                kind: 'fields',
                rows: [
                  ['Kind', f.kind],
                  ['Code', f.code],
                  ['Severity', f.severity],
                  ['State', f.state],
                  ['Object', f.object],
                  ['Summary', f.summary],
                  ['Occurrences', String(f.occurrences)],
                  ['First seen', ago(f.firstSeenAt, now)],
                  ['Last seen', ago(f.lastSeenAt, now)],
                  ['Resolution', f.resolution],
                  ['Security', f.securityRelevant ? 'relevant' : 'no'],
                ],
              },
            ],
          })
        }
      }
      return result({
        command: 'finding show',
        status: 'error',
        exitCode: EXIT.failure,
        error: { code: 'NOT_FOUND', message: `No finding ${id} on this target is visible to you.` },
      })
    },
  },
  showCommand({
    path: ['schema', 'overview'],
    summary: 'The schemas of a target with object counts, its fingerprint and what is visible.',
    group: 'diagnose',
    args: [{ name: 'target', description: 'A target id or path.', required: true }],
    action: 'schema.overview.get',
    scopes: SCHEMA,
    output: 'SchemaOverview',
    title: 'schema',
    operation: 'getSchemaOverview',
    params: (i) => ({ target: arg(i, 'target') }),
    view: (s, now) => [
      {
        kind: 'fields',
        rows: [
          ['Fingerprint', s.fingerprint],
          ['Complete', s.complete ? 'yes' : 'no (some objects are not visible)'],
          ['PostgreSQL', s.pgMajor === null ? null : String(s.pgMajor)],
          ['Read', `${s.source}, ${ago(s.observedAt, now)}`],
        ],
      },
      {
        kind: 'table',
        columns: [{ title: 'SCHEMA' }, { title: 'MANAGED' }, { title: 'OBJECTS', flexible: true }],
        rows: s.schemas.map((x) => [
          x.name,
          x.managed ? 'yes' : 'no',
          Object.entries(x.objectCounts)
            .map(([k, v]) => `${k} ${v}`)
            .join(', '),
        ]),
        empty: 'No schemas visible.',
      },
    ],
  }),
  listCommand({
    path: ['schema', 'search'],
    summary: 'Search a target’s catalog by name.',
    group: 'diagnose',
    args: [
      { name: 'target', description: 'A target id or path.', required: true },
      { name: 'query', description: 'Part of a name.', required: true },
    ],
    flags: [
      {
        name: 'kinds',
        type: 'list',
        placeholder: 'table,view',
        description: 'Only these object kinds.',
      },
    ],
    action: 'schema.search',
    scopes: SCHEMA,
    output: 'SchemaObjectList',
    title: 'schema search',
    operation: 'searchSchema',
    noun: 'object',
    params: (i) => ({ target: arg(i, 'target') }),
    query: (i) => ({
      q: arg(i, 'query'),
      ...(i.flags['kinds'] === undefined ? {} : { kinds: i.flags['kinds'] }),
    }),
    columns: [
      { title: 'KIND' },
      { title: 'SCHEMA' },
      { title: 'NAME', flexible: true },
      { title: 'PARENT' },
    ],
    row: (o) => [
      o.kind,
      o.schema,
      o.signature === null ? o.name : `${o.name}${o.signature}`,
      dash(o.parent),
    ],
    empty: 'Nothing matches.',
  }),
  showCommand({
    path: ['schema', 'show'],
    summary:
      'One catalog object: columns, constraints, indexes, grants, policies (definitions are untrusted text).',
    group: 'diagnose',
    args: [
      { name: 'target', description: 'A target id or path.', required: true },
      { name: 'kind', description: 'Object kind, e.g. table.', required: true },
      { name: 'name', description: 'Qualified name, e.g. public.leads.', required: true },
    ],
    action: 'schema.object.get',
    scopes: SCHEMA,
    output: 'SchemaObject',
    title: 'schema object',
    operation: 'getSchemaObject',
    params: (i) => ({
      target: arg(i, 'target'),
      kind: arg(i, 'kind'),
      qualifiedName: arg(i, 'name'),
    }),
    view: (o, now) => [
      {
        kind: 'fields',
        rows: [
          ['Owner', o.owner],
          ['Comment', o.comment],
          ['Observed', ago(o.observedAt, now)],
        ],
      },
      ...(o.columns === null
        ? []
        : [
            {
              kind: 'table' as const,
              columns: [
                { title: 'COLUMN' },
                { title: 'TYPE', flexible: true },
                { title: 'NULL' },
                { title: 'DEFAULT', flexible: true },
              ],
              rows: o.columns.map((c) => [
                c.name,
                c.type,
                c.nullable ? 'yes' : 'no',
                dash(c.default),
              ]),
            },
          ]),
      ...(o.indexes === null || o.indexes.length === 0
        ? []
        : [
            {
              kind: 'table' as const,
              columns: [
                { title: 'INDEX' },
                { title: 'VALID' },
                { title: 'DEFINITION', flexible: true },
              ],
              rows: o.indexes.map((x) => [x.name, x.valid ? 'yes' : 'NO', x.definition]),
            },
          ]),
      ...(o.definition === null
        ? []
        : [{ kind: 'text' as const, lines: o.definition.split('\n') }]),
    ],
  }),
  showCommand({
    path: ['schema', 'fingerprint'],
    summary: 'A target’s schema fingerprint (what plans and evidence bind).',
    group: 'diagnose',
    args: [{ name: 'target', description: 'A target id or path.', required: true }],
    action: 'schema.fingerprint.get',
    scopes: SCHEMA,
    output: 'SchemaFingerprint',
    title: 'fingerprint',
    operation: 'getSchemaFingerprint',
    params: (i) => ({ target: arg(i, 'target') }),
    view: (f, now) => [
      {
        kind: 'fields',
        rows: [
          ['Fingerprint', f.fingerprint],
          ['Entries', String(f.entries)],
          ['Complete', f.complete ? 'yes' : 'no'],
          ['Canonicalizer', f.canonicalizer],
          ['PostgreSQL', String(f.pgMajor)],
          ['Read', `${f.source}, ${ago(f.observedAt, now)}`],
        ],
      },
    ],
  }),
  {
    path: ['schema', 'diff'],
    summary: 'Compare two targets (or a target and a fingerprint) object by object.',
    group: 'diagnose',
    args: [
      { name: 'left', description: 'A target, or fingerprint:sha256:…', required: true },
      { name: 'right', description: 'A target, or fingerprint:sha256:…', required: true },
    ],
    locality: 'remote',
    effect: 'read',
    action: 'schema.diff',
    scopes: SCHEMA,
    output: 'SchemaDiff',
    async run(ctx, input) {
      const side = (v: string) =>
        v.startsWith('fingerprint:')
          ? { fingerprint: v.slice('fingerprint:'.length) }
          : { target: v }
      const body = checkedBody('createSchemaDiff', {
        left: side(arg(input, 'left')),
        right: side(arg(input, 'right')),
      })
      const remote = await ctx.remote()
      const d = must(await remote.sdk.call('createSchemaDiff', { body: body as never }))
      const rows = d.groups.flatMap((g) => [
        ...g.added.map((o) => ['+', g.objectClass, `${o.schema}.${o.name}`, '']),
        ...g.removed.map((o) => ['-', g.objectClass, `${o.schema}.${o.name}`, '']),
        ...g.changed.map((c) => [
          '~',
          g.objectClass,
          `${c.ref.schema}.${c.ref.name}`,
          c.attributes.join(', '),
        ]),
      ])
      return result({
        command: 'schema diff',
        data: d,
        blocks: [
          header('schema diff', remote.context),
          {
            kind: 'fields',
            rows: [
              ['Comparable', d.comparable ? 'yes' : 'no'],
              [
                'Totals',
                `+${d.totals.added} -${d.totals.removed} ~${d.totals.changed} (=${d.totals.matched})`,
              ],
              ['Security relevant', String(d.totals.securityRelevant)],
              ...(d.truncated ? [['Note', 'truncated by the server'] as [string, string]] : []),
            ],
          },
          {
            kind: 'table',
            columns: [
              { title: '' },
              { title: 'CLASS' },
              { title: 'OBJECT', flexible: true },
              { title: 'CHANGED', flexible: true },
            ],
            rows,
            empty: 'No differences.',
          },
        ],
      })
    },
  },
  {
    path: ['drift', 'check'],
    summary: 'Run a drift check of a target now (expected vs. live schema).',
    group: 'diagnose',
    args: [{ name: 'target', description: 'A target id or path.', required: true }],
    locality: 'remote',
    effect: 'plan',
    action: 'drift.check',
    scopes: SCHEMA,
    output: 'DriftCheck',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const d = must(
        await remote.sdk.call('runDriftCheck', {
          params: { target: arg(input, 'target') },
          body: {},
        }),
      )
      const drifted = d.counts.drifted > 0
      return result({
        command: 'drift check',
        status: d.errorCode !== null ? 'failed' : 'ok',
        exitCode: d.errorCode !== null ? EXIT.failure : EXIT.ok,
        data: d,
        ...(d.errorCode === null
          ? {}
          : { error: { code: d.errorCode, message: 'The drift check could not complete.' } }),
        blocks: [
          header('drift check', remote.context),
          {
            kind: 'status',
            word: drifted ? 'drifted' : d.status,
            tone: drifted ? 'warn' : 'ok',
            text: `${d.counts.drifted} drifted, ${d.counts.unmanaged} unmanaged, ${d.counts.matched} matched`,
          },
          {
            kind: 'table',
            columns: [
              { title: 'FINDING' },
              { title: 'BUCKET' },
              { title: 'KIND' },
              { title: 'SEVERITY' },
              { title: 'OBJECT', flexible: true },
            ],
            rows: d.findings.map((f) => [f.id, f.bucket, f.driftKind, f.severity, dash(f.object)]),
            empty: 'No findings.',
          },
        ],
        next: drifted ? [`exponetdb finding list --target ${d.targetId}`] : [],
      })
    },
  },
  showCommand({
    path: ['diagnose', 'query-stats'],
    summary:
      'Normalized statements of a target with calls, time, rows and I/O over a window (pg_stat_statements).',
    description:
      'CAPABILITY_UNAVAILABLE when pg_stat_statements is not installed or not preloaded. Statement text has its constants removed and is replaced when it could carry a secret; it is printed as data. A regression compares the last 24 hours with the last 7 days; migrations in between are a time coincidence, never a proven cause.',
    group: 'diagnose',
    args: [TARGET_ARG],
    flags: [
      {
        name: 'from',
        type: 'string',
        placeholder: 'time',
        description: 'Window start (RFC 3339).',
      },
      { name: 'to', type: 'string', placeholder: 'time', description: 'Window end (RFC 3339).' },
      {
        name: 'order',
        type: 'enum',
        values: ['total_time', 'mean_time', 'calls', 'io'],
        description: 'Order of the statements.',
      },
      { name: 'limit', type: 'number', description: 'Statements to show (1 to 500).' },
    ],
    action: 'query_stats.list',
    scopes: DIAG,
    output: 'QueryStats',
    title: 'query statistics',
    operation: 'getQueryStats',
    params: (i) => ({ target: arg(i, 'target') }),
    query: (i) => ({
      ...(flag(i, 'from') === undefined ? {} : { from: flag(i, 'from') }),
      ...(flag(i, 'to') === undefined ? {} : { to: flag(i, 'to') }),
      ...(i.flags['order'] === undefined ? {} : { order: i.flags['order'] }),
      ...(typeof i.flags['limit'] === 'number' ? { limit: i.flags['limit'] } : {}),
    }),
    view: (q, now) => [
      {
        kind: 'fields',
        rows: [
          ['Window', `${q.window.from} to ${q.window.to}`],
          [
            'Sampling',
            q.sampling === undefined
              ? null
              : `${q.sampling.state.replaceAll('_', ' ')}, every ${q.sampling.intervalSeconds}s, last ${ago(q.sampling.lastSampleAt, now)}${q.sampling.resets.length === 0 ? '' : `, ${q.sampling.resets.length} reset(s)`}${q.sampling.gaps.length === 0 ? '' : `, ${q.sampling.gaps.length} gap(s)`}`,
          ],
          ['Read', `${q.source}, ${ago(q.observedAt, now)}`],
          ...(q.truncated ? [['Note', 'truncated by the server'] as [string, string]] : []),
        ],
      },
      {
        kind: 'table',
        columns: [
          { title: 'DIGEST' },
          { title: 'CALLS', align: 'right' },
          { title: 'TOTAL MS', align: 'right' },
          { title: 'MEAN MS', align: 'right' },
          { title: 'ROWS', align: 'right' },
          { title: 'READ BLOCKS', align: 'right' },
          { title: 'REGRESSION' },
          { title: 'STATEMENT', flexible: true },
        ],
        rows: q.statements.map((st) => [
          shortDigest(st.digest),
          String(st.calls),
          ms(st.totalTimeMs),
          ms(st.meanTimeMs),
          String(st.rows),
          String(st.sharedBlocksRead),
          st.regression === undefined
            ? '-'
            : st.regression.state === 'regressed'
              ? `x${st.regression.factor?.toFixed(1) ?? '?'}`
              : st.regression.state.replaceAll('_', ' '),
          `${st.textRedacted === true ? '(redacted) ' : ''}${st.normalizedText}`,
        ]),
        empty: 'No statements in this window.',
      },
    ],
  }),
  showCommand({
    path: ['diagnose', 'table-stats'],
    summary:
      'Table and index sizes, scans, vacuum state, estimated bloat and transaction id age of a target.',
    description:
      'Bloat is an estimate (a heuristic page estimate, never measured). "Unused" means unused since the statistics were reset or the server started (shown as Since).',
    group: 'diagnose',
    args: [TARGET_ARG],
    flags: [
      { name: 'schema', type: 'string', placeholder: 'name', description: 'Only this schema.' },
      { name: 'limit', type: 'number', description: 'Tables to show (1 to 1000).' },
    ],
    action: 'table_stats.list',
    scopes: DIAG,
    output: 'TableStats',
    title: 'table statistics',
    operation: 'getTableStats',
    params: (i) => ({ target: arg(i, 'target') }),
    query: (i) => ({
      ...(flag(i, 'schema') === undefined ? {} : { schema: flag(i, 'schema') }),
      ...(typeof i.flags['limit'] === 'number' ? { limit: i.flags['limit'] } : {}),
    }),
    view: (t, now) => [
      {
        kind: 'fields',
        rows: [
          ['Since', t.statsSince === undefined || t.statsSince === null ? null : t.statsSince],
          [
            'Bloat',
            t.estimateMethod === undefined ? 'an estimate' : `an estimate (${t.estimateMethod})`,
          ],
          ['Read', `${t.source}, ${ago(t.observedAt, now)}`],
          ...(t.truncated ? [['Note', 'truncated by the server'] as [string, string]] : []),
        ],
      },
      {
        kind: 'table',
        columns: [
          { title: 'TABLE', flexible: true },
          { title: 'SIZE', align: 'right' },
          { title: 'INDEXES', align: 'right' },
          { title: 'SEQ SCANS', align: 'right' },
          { title: 'IDX SCANS', align: 'right' },
          { title: 'LIVE', align: 'right' },
          { title: 'DEAD', align: 'right' },
          { title: 'BLOAT (EST.)', align: 'right' },
          { title: 'XID AGE', align: 'right' },
          { title: 'LAST VACUUM' },
        ],
        rows: t.tables.map((x) => [
          `${x.schema}.${x.name}`,
          bytes(x.sizeBytes),
          bytes(x.indexSizeBytes),
          String(x.sequentialScans),
          String(x.indexScans),
          String(x.liveTuples),
          String(x.deadTuples),
          bytes(x.bloatEstimateBytes),
          String(x.xidAge),
          ago(
            [x.lastVacuumAt, x.lastAutovacuumAt]
              .filter((v): v is string => v !== null)
              .sort()
              .at(-1),
            now,
          ),
        ]),
        empty: 'No tables visible.',
      },
      {
        kind: 'table',
        columns: [
          { title: 'INDEX', flexible: true },
          { title: 'TABLE' },
          { title: 'SIZE', align: 'right' },
          { title: 'SCANS', align: 'right' },
          { title: 'VALID' },
          { title: 'DUPLICATE OF' },
        ],
        rows: t.indexes.map((x) => [
          `${x.schema}.${x.name}`,
          x.table,
          bytes(x.sizeBytes),
          String(x.scans),
          x.valid ? 'yes' : 'NO',
          dash(x.duplicateOf),
        ]),
        empty: 'No indexes visible.',
      },
    ],
  }),
  {
    path: ['diagnose', 'advisors'],
    summary:
      'Run the live advisors of a target (read-only): security, performance, operations, change safety.',
    description:
      'The server records each result as a finding (deduplicated). A rule that did not run is listed with its reason and is never a pass. A fix that can be drafted is a migration draft for review, never run here.',
    group: 'diagnose',
    args: [TARGET_ARG],
    flags: [
      {
        name: 'category',
        type: 'list',
        placeholder: ADVISOR_CATEGORIES.join(','),
        description: 'Categories to run (default security,performance).',
      },
    ],
    locality: 'remote',
    effect: 'read',
    action: 'advisor.run',
    scopes: DIAG,
    output: 'AdvisorRun',
    async run(ctx, input) {
      const categories = input.flags['category'] as readonly string[] | undefined
      const body = checkedBody(
        'runAdvisors',
        categories === undefined || categories.length === 0 ? {} : { categories },
      )
      const remote = await ctx.remote()
      const a = must(
        await remote.sdk.call('runAdvisors', {
          params: { target: arg(input, 'target') },
          body: body as never,
        }),
      )
      const now = ctx.io.now()
      const remediations = [...new Map(a.findings.map((f) => [f.rule, f.remediation])).entries()]
      const blocks: Block[] = [
        header('advisors', remote.context),
        {
          kind: 'fields',
          rows: [
            ['Ran', ago(a.ranAt, now)],
            ['Run', a.id ?? null],
            ['Catalog', a.catalogVersion === undefined ? null : `version ${a.catalogVersion}`],
          ],
        },
        {
          kind: 'table',
          columns: [
            { title: 'LEVEL' },
            { title: 'CATEGORY' },
            { title: 'RULE' },
            { title: 'OBJECT' },
            { title: 'MESSAGE', flexible: true },
            { title: 'FINDING' },
          ],
          rows: a.findings.map((f) => [
            f.level,
            f.category,
            f.rule,
            dash(f.object),
            f.message,
            dash(f.findingId),
          ]),
          empty: 'No advisor findings.',
        },
        ...((a.skipped ?? []).length === 0
          ? []
          : [
              {
                kind: 'table' as const,
                columns: [{ title: 'NOT RUN' }, { title: 'REASON' }],
                rows: (a.skipped ?? []).map((x) => [x.rule, x.reason.replaceAll('_', ' ')]),
              },
            ]),
        ...(remediations.length === 0
          ? []
          : [{ kind: 'text' as const, lines: remediations.map(([rule, r]) => `${rule}: ${r}`) }]),
      ]
      return result({ command: 'diagnose advisors', data: a, blocks })
    },
  },

  // ----- sessions -----
  showCommand({
    path: ['session', 'list'],
    summary:
      'Sessions of a target with redacted statements (the pid and start times the session actions take).',
    group: 'diagnose',
    args: [TARGET_ARG],
    flags: [
      {
        name: 'state',
        type: 'string',
        placeholder: 'state',
        description: 'Only this state (e.g. active).',
      },
      {
        name: 'min-age',
        type: 'number',
        placeholder: 'seconds',
        description: 'Only sessions at least this old.',
      },
      {
        name: 'application',
        type: 'string',
        placeholder: 'name',
        description: 'Only this application_name.',
      },
      { name: 'limit', type: 'number', description: 'Sessions to show (1 to 1000).' },
    ],
    action: 'session.list',
    scopes: DIAG,
    output: 'SessionList',
    title: 'sessions',
    operation: 'listSessions',
    params: (i) => ({ target: arg(i, 'target') }),
    query: (i) => ({
      ...(flag(i, 'state') === undefined ? {} : { state: flag(i, 'state') }),
      ...(typeof i.flags['min-age'] === 'number' ? { minAgeSeconds: i.flags['min-age'] } : {}),
      ...(flag(i, 'application') === undefined ? {} : { application: flag(i, 'application') }),
      ...(typeof i.flags['limit'] === 'number' ? { limit: i.flags['limit'] } : {}),
    }),
    view: (l, now) => [
      {
        kind: 'fields',
        rows: [
          ['Read', `${l.source}, ${ago(l.observedAt, now)}`],
          ...(l.truncated ? [['Note', `truncated at ${l.cap}`] as [string, string]] : []),
        ],
      },
      {
        kind: 'table',
        columns: [
          { title: 'PID', align: 'right' },
          { title: 'STATE' },
          { title: 'ROLE' },
          { title: 'APPLICATION' },
          { title: 'BACKEND START' },
          { title: 'QUERY START' },
          { title: 'WAIT' },
          { title: 'STATEMENT', flexible: true },
        ],
        rows: l.sessions.map((x) => [
          String(x.pid),
          x.state,
          x.role,
          dash(x.applicationName),
          x.backendStart,
          dash(x.queryStart),
          x.waitEvent === null ? '-' : `${x.waitEvent.type}:${x.waitEvent.event}`,
          x.statement === null ? '-' : x.statement.redacted,
        ]),
        empty: 'No sessions visible.',
      },
    ],
  }),
  {
    path: ['session', 'cancel'],
    summary:
      'Cancel a session’s running query (inline, low): only while the same backend runs the same query.',
    description:
      'Bound to the pid, the backend start and the query start you saw (`session list`), re-checked in the cancelling statement; never a replication, backup or ExponetDB session. Production needs connections.operate:prod. Waits by default.',
    group: 'diagnose',
    args: [TARGET_ARG, PID_ARG],
    flags: [
      BACKEND_START,
      {
        name: 'query-start',
        type: 'string',
        placeholder: 'time',
        description: 'The query start (RFC 3339, as `session list` shows it).',
        required: true,
      },
      ...WAIT_FLAGS,
    ],
    locality: 'remote',
    effect: 'mutation',
    action: 'connections.cancel',
    scopes: CONNECTIONS,
    output: 'Operation',
    async run(ctx, input) {
      const params = { target: arg(input, 'target'), pid: pid(input) }
      const body = checkedBody('cancelSessionQuery', {
        backendStart: String(input.flags['backend-start']),
        queryStart: String(input.flags['query-start']),
      })
      const remote = await ctx.remote()
      const op = must(
        await remote.sdk.call('cancelSessionQuery', {
          // The path takes the pid as text (the generated type says number).
          params: params as never,
          body: body as never,
          idempotencyKey: randomUUID(),
        }),
      )
      return inlineResult(ctx, remote, 'session cancel', op, input.flags)
    },
  },
  planCommand({
    path: ['session', 'terminate'],
    summary:
      'Plan terminating a session, bound to its pid and backend start; the condition is re-checked when it is terminated.',
    description:
      'stalled: active, waiting on the client, query 60 s or older; idle_in_transaction: idle in a transaction for 60 s or more; long_running: active, query 300 s or older; any. Production needs connections.operate:prod, and an agent’s production plan a human approval.',
    group: 'diagnose',
    args: [TARGET_ARG, PID_ARG],
    flags: [
      BACKEND_START,
      {
        name: 'condition',
        type: 'enum',
        values: ['stalled', 'idle_in_transaction', 'long_running', 'any'],
        description: 'What must still hold when the session is terminated.',
        required: true,
      },
      { name: 'reason', type: 'string', placeholder: 'text', description: 'Why.' },
    ],
    action: 'connections.terminate.plan',
    scopes: CONNECTIONS,
    operation: 'planSessionTermination',
    // The path takes the pid as text (the generated type says number).
    params: (i) => ({ target: arg(i, 'target'), pid: pid(i) }) as never,
    body: (i) => ({
      backendStart: String(i.flags['backend-start']),
      condition: String(i.flags['condition']),
      ...(flag(i, 'reason') === undefined ? {} : { reason: flag(i, 'reason') }),
    }),
    file: false,
  }),
]

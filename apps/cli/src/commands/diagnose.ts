import { EXIT } from '../cli/exit.ts'
import { checkedBody } from '../cli/planning.ts'
import { arg, listCommand, showCommand, TARGET_FLAG } from '../cli/reads.ts'
import { must } from '../cli/remote.ts'
import type { CommandSpec } from '../cli/types.ts'
import { ago, dash, header } from '../output/format.ts'
import { result } from '../output/model.ts'

/**
 * Diagnostics that exist in this wave: target health, findings, schema
 * reads and drift checks ([`10-observability/`](../../../../exponetdb-docs/10-observability/README.md)).
 * Every read carries its source and time; a failed read is an error, never
 * an empty list. Wave 9 diagnostics (query statistics, advisors, backups)
 * are not offered.
 */
const DIAG = ['diagnostics.read']
const SCHEMA = ['schema.read']

const TARGET_REQUIRED = { ...TARGET_FLAG, required: true }

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
    summary: 'Findings of a target (drift, health, security), open by default.',
    group: 'diagnose',
    flags: [
      TARGET_REQUIRED,
      { name: 'include-resolved', type: 'boolean', description: 'Also resolved findings.' },
      {
        name: 'severity',
        type: 'enum',
        values: ['info', 'warning', 'critical'],
        description: 'Only this severity.',
      },
      { name: 'kind', type: 'string', placeholder: 'kind', description: 'Only this kind.' },
    ],
    action: 'target.finding.list',
    scopes: DIAG,
    output: 'FindingList',
    title: 'findings',
    operation: 'listTargetFindings',
    noun: 'finding',
    params: (i) => ({ target: String(i.flags['target']) }),
    query: (i) => ({
      ...(i.flags['include-resolved'] === true ? { includeResolved: true } : {}),
      ...(i.flags['severity'] === undefined ? {} : { severity: i.flags['severity'] }),
      ...(i.flags['kind'] === undefined ? {} : { kind: i.flags['kind'] }),
    }),
    columns: [
      { title: 'FINDING' },
      { title: 'SEVERITY' },
      { title: 'CODE' },
      { title: 'OBJECT' },
      { title: 'SUMMARY', flexible: true },
      { title: 'LAST SEEN' },
    ],
    row: (f, now) => [f.id, f.severity, f.code, dash(f.object), f.summary, ago(f.lastSeenAt, now)],
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
]

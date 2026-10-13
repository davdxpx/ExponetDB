import {
  type SchemaDiffEntry,
  SchemaDiffView,
  type StructuredDiffRow,
  StructuredDiffTable,
} from '@exponetdb/ui-data'
import type { DemoDefinition } from '../types.ts'
import { minutesAgo, NOW } from '../ui-patterns/clock.ts'

const OBSERVED = minutesAgo(1)

function ready<T>(value: T) {
  return { state: 'ready' as const, value, source: 'live' as const, observedAt: OBSERVED }
}

const SETTINGS: readonly StructuredDiffRow[] = [
  { key: 'work_mem', before: '4MB', after: '8MB' },
  { key: 'log_min_duration_statement', before: null, after: '500ms' },
  { key: 'statement_timeout', before: '30s', after: null },
  { key: 'max_connections', before: '100', after: '100' },
]

const GRANTS: readonly StructuredDiffRow[] = [
  { key: 'app_rw on public.orders', before: 'SELECT, INSERT', after: 'SELECT, INSERT, UPDATE' },
  { key: 'app_ro on public.orders', before: null, after: 'SELECT' },
  { key: 'app_rw on public.orders_archive', before: 'SELECT', after: null },
]

const ENTRIES: readonly SchemaDiffEntry[] = [
  {
    objectType: 'table',
    schema: 'public',
    name: 'order_notes',
    change: 'added',
    classes: [],
    details: 'create table public.order_notes (order_id bigint, note text)',
  },
  {
    objectType: 'table',
    schema: 'public',
    name: 'orders_archive',
    change: 'removed',
    classes: ['destructive'],
    details: 'drop table public.orders_archive',
  },
  {
    objectType: 'column',
    schema: 'public',
    name: 'orders.total',
    change: 'changed',
    classes: ['rewrite'],
    details: 'alter column total type numeric(14,2): rewrites the table',
  },
  {
    objectType: 'index',
    schema: 'public',
    name: 'orders_customer_idx',
    change: 'added',
    classes: ['non_transactional'],
    details: 'create index concurrently orders_customer_idx on public.orders (customer_id)',
  },
  {
    objectType: 'policy',
    schema: 'public',
    name: 'orders_owner_only',
    change: 'changed',
    classes: ['security'],
    details: "using (owner_id = current_setting('app.user_id')::bigint)",
  },
  {
    objectType: 'publication',
    schema: '',
    name: 'orders_stream',
    change: 'added',
    classes: [],
    details: 'create publication orders_stream for table public.orders',
  },
  {
    objectType: 'view',
    schema: 'public',
    name: 'open_orders\u{202E}wen',
    change: 'changed',
    classes: [],
    details: "select * from orders where status = 'open'\u{200B}",
  },
]

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-data/structured-diff/settings',
    title:
      'Settings before and after: added, removed, changed and unchanged rows, each with a word',
    render: () => (
      <StructuredDiffTable
        rows={ready(SETTINGS)}
        what="settings"
        keyLabel="Setting"
        absentLabel="not set"
        now={NOW}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/structured-diff/grants',
    title: 'Grants before and after, with "not granted" for an absent grant',
    render: () => (
      <StructuredDiffTable
        rows={ready(GRANTS)}
        what="grants"
        keyLabel="Grant"
        absentLabel="not granted"
        now={NOW}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/structured-diff/failed',
    title: 'A failed read is never "No differences"',
    render: () => (
      <StructuredDiffTable
        rows={{
          state: 'failed',
          error: {
            code: 'TARGET_UNREACHABLE',
            message: 'The target did not answer within 5 seconds.',
          },
        }}
        what="settings"
        onRetry={() => undefined}
        now={NOW}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/structured-diff/no-differences',
    title: 'No differences, said only after a read that succeeded',
    render: () => (
      <StructuredDiffTable
        rows={ready([{ key: 'work_mem', before: '4MB', after: '4MB' }])}
        what="settings"
        now={NOW}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/schema-diff/by-object',
    title: 'Schema diff by object: groups in dependency order, a change marker and class badges',
    render: () => <SchemaDiffView diff={ready(ENTRIES)} now={NOW} headingLevel={3} />,
  },
  {
    id: 'ui-data/schema-diff/partial',
    title: 'A partial read says what is missing and never claims to be the whole diff',
    render: () => (
      <SchemaDiffView
        diff={{
          state: 'partial',
          value: ENTRIES.slice(0, 3),
          source: 'agent_reported',
          observedAt: OBSERVED,
          missing: ['functions: the catalog read for this schema timed out'],
        }}
        now={NOW}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/schema-diff/failed',
    title: 'A failed read of the diff',
    render: () => (
      <SchemaDiffView
        diff={{
          state: 'failed',
          error: {
            code: 'TARGET_UNREACHABLE',
            message: 'The target did not answer within 5 seconds.',
          },
        }}
        onRetry={() => undefined}
        now={NOW}
        headingLevel={3}
      />
    ),
  },
]

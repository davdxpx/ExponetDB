import {
  ReadableTextDiff,
  type SqlCompletionProvider,
  type SqlDiagnostic,
  type TextDiffSides,
} from '@exponetdb/ui-data'
import { SqlEditor } from '@exponetdb/ui-data/editor/sql-editor'
import { TextDiffView } from '@exponetdb/ui-data/editor/text-diff'
import { Admonition } from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { minutesAgo, NOW } from '../ui-patterns/clock.ts'

/**
 * CodeMirror measures text with the layout engine of a browser. The environment of the component tests
 * (jsdom) has none, so the editors would only log errors there. The demos check for it and say so; the
 * tests of this app install a stand-in for the layout and then render the real editors.
 */
function canMeasureText(): boolean {
  return typeof Range !== 'undefined' && typeof Range.prototype.getClientRects === 'function'
}

function NeedsBrowser({ children, what }: { children: ReactNode; what: string }): ReactNode {
  if (canMeasureText()) return children
  return (
    <Admonition
      type="info"
      title={`${what} needs a browser`}
      description="This environment has no layout engine, so the editor is not drawn here."
    />
  )
}

const QUERY = `select id, status, total
from orders
where placed_at > now() - interval '1 day'
order by placed_at desc
limit 100;`

const DRAFT = `alter table orders add column placed_at timestamptz;
create index orders_customer_idx on orders (customer_id);
drop table if exists orders_archive;`

const DIAGNOSTICS: readonly SqlDiagnostic[] = [
  {
    line: 1,
    column: 7,
    severity: 'warning',
    message: 'Adding a column takes a short ACCESS EXCLUSIVE lock on orders.',
  },
  {
    line: 2,
    severity: 'error',
    message:
      'CREATE INDEX blocks writes to orders. Use CREATE INDEX CONCURRENTLY in its own migration.',
  },
  {
    line: 3,
    column: 1,
    endLine: 3,
    endColumn: 52,
    severity: 'info',
    message: 'This statement is classified as destructive.',
  },
]

const HOSTILE = [
  '-- reviewed by ops \u{05D0} + 99',
  "select * from orders where status = 'open'\u{200B};",
  'drop table orders\u{202E}; -- harmless',
].join('\n')

const COMPLETIONS = [
  { label: 'orders', kind: 'table', detail: 'public' },
  { label: 'order_items', kind: 'table', detail: 'public' },
  { label: 'customers', kind: 'table', detail: 'public' },
  { label: 'status', kind: 'column', detail: 'orders.status text' },
  { label: 'total', kind: 'column', detail: 'orders.total numeric' },
] as const

const provider: SqlCompletionProvider = async ({ word }) => {
  const needle = word.split('.').pop()?.toLowerCase() ?? ''
  return COMPLETIONS.filter((item) => item.label.startsWith(needle))
}

const BEFORE = `create table orders (
  id bigint primary key,
  customer_id bigint not null,
  status text not null default 'open'
);`

const AFTER = `create table orders (
  id bigint primary key,
  customer_id bigint not null,
  status text not null default 'open',
  placed_at timestamptz not null default now()
);

create index orders_customer_idx on orders (customer_id);`

function QueryEditor(): ReactNode {
  const [value, setValue] = useState(QUERY)
  const [log, setLog] = useState(
    'Press Control+Enter in the editor. Nothing is run by the editor itself.',
  )
  return (
    <div className="flex flex-col gap-3">
      <SqlEditor
        label="Query"
        mode="query"
        value={value}
        onChange={setValue}
        completion={provider}
        minLines={4}
        onRun={() => setLog('The page would ask the server to run this one read-only statement.')}
      />
      <p role="status" className="text-sm text-foreground-light">
        {log}
      </p>
    </div>
  )
}

function DraftEditor(): ReactNode {
  const [value, setValue] = useState(DRAFT)
  return (
    <SqlEditor
      label="Migration draft"
      mode="draft"
      value={value}
      onChange={setValue}
      diagnostics={DIAGNOSTICS}
      minLines={4}
    />
  )
}

const SIDES: TextDiffSides = { before: BEFORE, after: AFTER }

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-data/sql-editor/query',
    title: 'Query mode: Control+Enter calls the page, which decides what "run" means',
    visual: false,
    render: () => (
      <NeedsBrowser what="The SQL editor">
        <QueryEditor />
      </NeedsBrowser>
    ),
  },
  {
    id: 'ui-data/sql-editor/draft',
    title: 'Draft mode with the findings of the server: a line marked and a list below',
    visual: false,
    render: () => (
      <NeedsBrowser what="The SQL editor">
        <DraftEditor />
      </NeedsBrowser>
    ),
  },
  {
    id: 'ui-data/sql-editor/readonly',
    title: 'Read-only mode with hidden and direction characters shown by code point',
    visual: false,
    render: () => (
      <NeedsBrowser what="The SQL editor">
        <SqlEditor label="Statement text" mode="readonly" value={HOSTILE} minLines={3} />
      </NeedsBrowser>
    ),
  },
  {
    id: 'ui-data/text-diff/migration',
    title: 'Text diff: up.sql of a draft against the applied text, side by side and read-only',
    visual: false,
    render: () => (
      <NeedsBrowser what="The text diff">
        <TextDiffView
          label="up.sql: draft against applied"
          before={BEFORE}
          after={AFTER}
          beforeLabel="Applied"
          afterLabel="Draft"
          maxLines={14}
        />
      </NeedsBrowser>
    ),
  },
  {
    id: 'ui-data/readable-text-diff/ready',
    title: 'The diff behind a read: it loads the viewer when there is something to compare',
    visual: false,
    render: () => (
      <NeedsBrowser what="The text diff">
        <ReadableTextDiff
          label="up.sql: draft against applied"
          what="migration text"
          readable={{ state: 'ready', value: SIDES, source: 'live', observedAt: minutesAgo(1) }}
          now={NOW}
          maxLines={14}
        />
      </NeedsBrowser>
    ),
  },
  {
    id: 'ui-data/readable-text-diff/failed',
    title: 'A failed read shows the failure and never a comparison or "No differences"',
    render: () => (
      <ReadableTextDiff
        label="up.sql: draft against applied"
        what="migration text"
        readable={{
          state: 'failed',
          error: {
            code: 'MIGRATION_NOT_FOUND',
            message: 'The stored text of this migration was not found.',
          },
        }}
        onRetry={() => undefined}
        now={NOW}
      />
    ),
  },
  {
    id: 'ui-data/readable-text-diff/loading',
    title: 'Loading: a skeleton and a spoken status',
    render: () => (
      <ReadableTextDiff
        label="up.sql: draft against applied"
        what="migration text"
        readable={{ state: 'loading' }}
        now={NOW}
      />
    ),
  },
]

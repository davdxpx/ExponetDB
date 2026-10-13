import { PlanFrame, RawPlanTextBlock } from '@exponetdb/ui-data'
import { SqlEditor } from '@exponetdb/ui-data/editor/sql-editor'
import { TextDiffView } from '@exponetdb/ui-data/editor/text-diff'
import { SchemaErd } from '@exponetdb/ui-data/erd/schema-erd'
import { DataGrid } from '@exponetdb/ui-data/grid/data-grid'
import type { CspCase } from './case-types.ts'

/**
 * The CSP cases of the data components (Phase 5): the grid with thousands of
 * rows and its value sheet, the SQL editor and the text diff (CodeMirror in a
 * shadow root, constructable stylesheets), the schema diagram (xyflow) and the
 * production plan frame with its raw text. The heavy modules are the same
 * subpath exports the Web App loads lazily. Each case holds the right-to-left
 * probe where it shows foreign text, so the browser test can check the
 * logical order there too.
 */
const BIDI = 'UPDATE accounts SET amount = 1 /*\u{5D0}*/ + 99 --\u{5D1}'
const NOW = '2026-10-13T12:00:00.000Z'

const gridRows = Array.from({ length: 5000 }, (_, i) => [
  i + 1,
  i === 0 ? BIDI : `customer ${i + 1}`,
  i % 7 === 0 ? null : `${(i * 13) % 1000}.00`,
])

function pressOnFirstCell(): void {
  const cell = document.querySelector<HTMLElement>('[role="gridcell"]')
  cell?.focus()
  cell?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

export const DATA_CASES: readonly CspCase[] = [
  {
    id: 'data-grid',
    title: 'Data grid with 5,000 rows and the full-value sheet',
    render: () => (
      <div data-bidi-probe="grid">
        <DataGrid
          label="Query result"
          columns={[
            { name: 'id', type: 'int8' },
            { name: 'name', type: 'text' },
            { name: 'balance', type: 'numeric' },
          ]}
          rows={{ state: 'ready', value: gridRows, source: 'live', observedAt: NOW }}
          now={NOW}
          maxHeight={360}
        />
      </div>
    ),
    act: pressOnFirstCell,
  },
  {
    id: 'sql-editor',
    title: 'SQL editor with diagnostics, completion and the right-to-left probe',
    render: () => (
      <SqlEditor
        label="SQL"
        mode="query"
        value={`${BIDI}\nSELECT * FROM public.orders WHERE id = 1;`}
        diagnostics={[
          { severity: 'warning', message: 'This statement writes.', line: 1, column: 1 },
        ]}
        completion={async () => [{ label: 'orders', kind: 'table' }]}
        onRun={() => undefined}
        className="exdb-bidi-editor"
      />
    ),
  },
  {
    id: 'text-diff',
    title: 'Text diff of two migration texts',
    render: () => (
      <TextDiffView
        label="Migration change"
        before={'CREATE TABLE public.orders (id bigint);\n'}
        after={`CREATE TABLE public.orders (id bigint, note text);\n${BIDI}\n`}
        sql
      />
    ),
  },
  {
    id: 'schema-erd',
    title: 'Schema diagram',
    render: () => (
      <div className="h-[420px]">
        <SchemaErd
          readable={{
            state: 'ready',
            source: 'live',
            observedAt: NOW,
            value: {
              tables: [
                {
                  id: 'public.customers',
                  schema: 'public',
                  name: 'customers',
                  columns: [{ name: 'id', type: 'bigint', pk: true }],
                },
                {
                  id: 'public.orders',
                  schema: 'public',
                  name: 'orders',
                  columns: [
                    { name: 'id', type: 'bigint', pk: true },
                    { name: 'customer_id', type: 'bigint' },
                  ],
                },
              ],
              relations: [
                {
                  name: 'orders_customer_fk',
                  fromTable: 'public.orders',
                  fromColumns: ['customer_id'],
                  toTable: 'public.customers',
                  toColumns: ['id'],
                },
              ],
            },
          }}
          now={NOW}
        />
      </div>
    ),
  },
  {
    id: 'plan-frame',
    title: 'Production plan frame with the raw plan text',
    render: () => (
      <div data-bidi-probe="raw-plan">
        <PlanFrame production>
          <RawPlanTextBlock
            files={[
              {
                migrationId: '01M4S9000000000000000000AB',
                file: 'up.sql',
                revision: 1,
                bytes: BIDI.length,
                truncated: false,
                lines: [
                  { text: BIDI, statement: { index: 0, kind: 'update', lock: 'ROW EXCLUSIVE' } },
                ],
              },
            ]}
            omitted={0}
            runs={1}
          />
        </PlanFrame>
      </div>
    ),
  },
]

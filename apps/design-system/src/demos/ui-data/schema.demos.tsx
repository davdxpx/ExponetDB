import {
  SchemaTree,
  type SchemaTreeLoader,
  type SchemaTreeObject,
  type SchemaTreeSelection,
} from '@exponetdb/ui-data'
import { SchemaErd } from '@exponetdb/ui-data/erd/schema-erd'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { minutesAgo, NOW } from '../ui-patterns/clock.ts'

const OBSERVED = minutesAgo(1)

function ready<T>(value: T) {
  return { state: 'ready' as const, value, source: 'live' as const, observedAt: OBSERVED }
}

const OBJECTS: Readonly<Record<string, Readonly<Record<string, readonly SchemaTreeObject[]>>>> = {
  public: {
    table: [{ name: 'orders' }, { name: 'order_items' }, { name: 'customers' }],
    view: [{ name: 'open_orders' }],
    function: [
      { name: 'order_total', key: 'order_total(bigint)' },
      { name: 'order_total', key: 'order_total(bigint, text)' },
    ],
  },
  billing: {
    table: [{ name: 'invoices' }, { name: 'payments' }],
  },
}

/** Reads the objects of one class: a short wait like a request, a failure for one branch. */
const loadObjects: SchemaTreeLoader = async ({ schema, classId }) => {
  await new Promise((resolve) => setTimeout(resolve, 150))
  if (schema === 'billing' && classId === 'view') {
    return {
      state: 'failed',
      error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer within 5 seconds.' },
    }
  }
  return ready(OBJECTS[schema]?.[classId] ?? [])
}

function describeSelection(selection: SchemaTreeSelection | null): string {
  if (selection === null) return 'Nothing is selected.'
  if (selection.kind === 'schema') return `Selected the schema ${selection.schema}.`
  if (selection.kind === 'class') return `Selected ${selection.classId} in ${selection.schema}.`
  return `Selected ${selection.classId} ${selection.name} in ${selection.schema}.`
}

function BrowsableTree(): ReactNode {
  const [selection, setSelection] = useState<SchemaTreeSelection | null>(null)
  return (
    <div className="flex flex-col gap-3">
      <SchemaTree
        aria-label="Schemas of shop/platform/staging"
        schemas={ready([{ name: 'public' }, { name: 'billing' }, { name: 'audit\u{202E}log' }])}
        loadObjects={loadObjects}
        onSelect={setSelection}
        now={NOW}
        headingLevel={3}
      />
      <p role="status" className="text-sm text-foreground-light">
        {describeSelection(selection)}
      </p>
    </div>
  )
}

const ERD_TABLES = [
  {
    id: 'customers',
    schema: 'public',
    name: 'customers',
    columns: [
      { name: 'id', type: 'bigint', pk: true },
      { name: 'name', type: 'text' },
    ],
  },
  {
    id: 'orders',
    schema: 'public',
    name: 'orders',
    columns: [
      { name: 'id', type: 'bigint', pk: true },
      { name: 'customer_id', type: 'bigint' },
      { name: 'status', type: 'text' },
      { name: 'placed_at', type: 'timestamptz' },
    ],
  },
  {
    id: 'order_items',
    schema: 'public',
    name: 'order_items',
    columns: [
      { name: 'order_id', type: 'bigint', pk: true },
      { name: 'sku', type: 'text', pk: true },
      { name: 'quantity', type: 'integer' },
    ],
  },
  {
    id: 'products',
    schema: 'public',
    name: 'products',
    columns: [
      { name: 'sku', type: 'text', pk: true },
      { name: 'title', type: 'text' },
    ],
  },
] as const

const ERD_DATA = {
  tables: ERD_TABLES.map((table) => ({ ...table, columns: [...table.columns] })),
  relations: [
    {
      name: 'orders_customer_id_fkey',
      fromTable: 'orders',
      fromColumns: ['customer_id'],
      toTable: 'customers',
      toColumns: ['id'],
    },
    {
      name: 'order_items_order_id_fkey',
      fromTable: 'order_items',
      fromColumns: ['order_id'],
      toTable: 'orders',
      toColumns: ['id'],
    },
    {
      name: 'order_items_sku_fkey',
      fromTable: 'order_items',
      fromColumns: ['sku'],
      toTable: 'products',
      toColumns: ['sku'],
    },
  ],
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-data/schema-tree/browse',
    title: 'Schema tree: each branch loads when it opens, and one branch can fail on its own',
    visual: false,
    render: () => <BrowsableTree />,
  },
  {
    id: 'ui-data/schema-tree/schemas',
    title: 'Schema tree at rest: schemas as branches, one name with a direction override',
    render: () => (
      <SchemaTree
        aria-label="Schemas of shop/platform/staging"
        schemas={ready([{ name: 'public' }, { name: 'billing' }, { name: 'audit\u{202E}log' }])}
        loadObjects={loadObjects}
        now={NOW}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/schema-tree/failed',
    title: 'The schemas could not be read: a failure, never an empty tree',
    render: () => (
      <SchemaTree
        schemas={{
          state: 'failed',
          error: {
            code: 'TARGET_UNREACHABLE',
            message: 'The target did not answer within 5 seconds.',
          },
        }}
        loadObjects={loadObjects}
        onRetry={() => undefined}
        now={NOW}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/schema-erd/diagram',
    title: 'Schema diagram: tables with their keys, and the foreign keys as connections',
    visual: false,
    render: () => <SchemaErd readable={ready(ERD_DATA)} now={NOW} headingLevel={3} />,
  },
  {
    id: 'ui-data/schema-erd/table-view',
    title: 'The same schema as tables and relations in text, the alternative to the picture',
    render: () => (
      <SchemaErd readable={ready(ERD_DATA)} initialView="table" now={NOW} headingLevel={3} />
    ),
  },
  {
    id: 'ui-data/schema-erd/over-the-limit',
    title: 'Too many tables for a diagram: the page says so and shows the table view only',
    render: () => <SchemaErd readable={ready(ERD_DATA)} maxNodes={2} now={NOW} headingLevel={3} />,
  },
  {
    id: 'ui-data/schema-erd/failed',
    title: 'A failed read is never an empty diagram',
    render: () => (
      <SchemaErd
        readable={{
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

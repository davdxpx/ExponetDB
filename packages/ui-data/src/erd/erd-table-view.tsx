import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { formatCount, UntrustedName } from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useState } from 'react'

import { keysFor } from './keys.ts'
import type { ErdModel } from './model.ts'
import type { ErdColumn, ErdRelation, ErdTable } from './types.ts'

/** Tables and relations listed before "Show more": the lists must stay light for a large schema. */
export const TABLE_VIEW_PAGE_SIZE = 100
export const RELATION_VIEW_PAGE_SIZE = 200

function qualified(table: ErdTable): string {
  return `${table.schema}.${table.name}`
}

function ColumnItem({
  column,
  isForeignKey,
}: {
  column: ErdColumn
  isForeignKey: boolean
}): ReactNode {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <UntrustedName name={column.name} mono maxCodePoints={63} label="column name" />
      <span className="text-foreground-light">
        <UntrustedName name={column.type} mono maxCodePoints={48} label="column type" />
      </span>
      {column.pk === true && (
        <span className="rounded-sm border border-default px-1 text-[11px] leading-4 text-foreground-light">
          primary key
        </span>
      )}
      {isForeignKey && (
        <span className="rounded-sm border border-default px-1 text-[11px] leading-4 text-foreground-light">
          foreign key
        </span>
      )}
    </li>
  )
}

function TableEndpoint({
  tableId,
  columns,
  model,
}: {
  tableId: string
  columns: readonly string[]
  model: ErdModel
}): ReactNode {
  const table = model.tableById.get(tableId)
  const keys = keysFor(columns)
  return (
    <span className="flex flex-col gap-0.5">
      {table === undefined ? (
        <span>
          <UntrustedName name={tableId} mono maxCodePoints={63} label="table id" />{' '}
          <span className="text-foreground-lighter">(table not in this read)</span>
        </span>
      ) : (
        <UntrustedName name={qualified(table)} mono maxCodePoints={80} label="table name" />
      )}
      <span className="text-foreground-light">
        {'('}
        {columns.length === 0 ? (
          <span className="italic">no columns</span>
        ) : (
          columns.map((column, index) => (
            <span key={keys[index]}>
              {index > 0 && ', '}
              <UntrustedName name={column} mono maxCodePoints={63} label="column name" />
            </span>
          ))
        )}
        {')'}
      </span>
    </span>
  )
}

function RelationRow({ relation, model }: { relation: ErdRelation; model: ErdModel }): ReactNode {
  return (
    <TableRow>
      <TableHead
        scope="row"
        className="h-auto px-3 py-2 align-top font-sans normal-case tracking-normal text-foreground"
      >
        <UntrustedName name={relation.name} mono maxCodePoints={63} label="relation name" />
      </TableHead>
      <TableCell className="px-3 py-2 align-top">
        <TableEndpoint tableId={relation.fromTable} columns={relation.fromColumns} model={model} />
      </TableCell>
      <TableCell className="px-3 py-2 align-top">
        <TableEndpoint tableId={relation.toTable} columns={relation.toColumns} model={model} />
      </TableCell>
    </TableRow>
  )
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`
}

export interface SchemaErdTablesProps {
  model: ErdModel
}

/**
 * The schema as text: every table with its columns (type, primary and foreign key marked in
 * words) and every relation with both ends. It is the accessible alternative to the diagram and
 * the view for a schema too large to draw. Names are untrusted text; long lists are shown in
 * pages with an explicit "Show more".
 */
export function SchemaErdTables({ model }: SchemaErdTablesProps): ReactNode {
  const [tableLimit, setTableLimit] = useState(TABLE_VIEW_PAGE_SIZE)
  const [relationLimit, setRelationLimit] = useState(RELATION_VIEW_PAGE_SIZE)

  const headingId = useId()
  const foreignKeys = new Map(model.nodes.map((node) => [node.table.id, node.foreignKeyColumns]))
  const tables = model.tables.slice(0, tableLimit)
  const columnKeys = new Map(
    tables.map((table) => [table.id, keysFor(table.columns.map((column) => column.name))]),
  )
  const relations = model.relations.slice(0, relationLimit)
  const relationKeys = keysFor(relations.map((relation) => relation.name))
  const moreTables = model.tables.length - tables.length
  const moreRelations = model.relations.length - relations.length

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby={`${headingId}-tables`} className="flex flex-col gap-2">
        <h3 id={`${headingId}-tables`} className="text-sm font-medium text-foreground">
          {plural(model.tables.length, 'table')}
        </h3>
        <Table containerProps={{ 'aria-label': 'Tables and their columns, scrollable' }}>
          <caption className="sr-only">Tables and their columns</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="h-auto px-3 py-2">
                Table
              </TableHead>
              <TableHead scope="col" className="h-auto px-3 py-2">
                Columns
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tables.map((table) => (
              <TableRow key={table.id}>
                <TableHead
                  scope="row"
                  className="h-auto px-3 py-2 align-top font-sans normal-case tracking-normal text-foreground whitespace-normal"
                >
                  <UntrustedName
                    name={qualified(table)}
                    mono
                    maxCodePoints={80}
                    label="table name"
                  />
                </TableHead>
                <TableCell className="px-3 py-2 align-top">
                  {table.columns.length === 0 ? (
                    <span className="italic text-foreground-light">No columns</span>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {table.columns.map((column, index) => (
                        <ColumnItem
                          key={columnKeys.get(table.id)?.[index]}
                          column={column}
                          isForeignKey={foreignKeys.get(table.id)?.has(column.name) === true}
                        />
                      ))}
                    </ul>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {moreTables > 0 && (
          <div>
            <Button
              type="button"
              variant="outline"
              size="tiny"
              onClick={() => setTableLimit(tableLimit + TABLE_VIEW_PAGE_SIZE)}
            >
              {`Show ${formatCount(Math.min(TABLE_VIEW_PAGE_SIZE, moreTables))} more tables (${formatCount(moreTables)} not shown)`}
            </Button>
          </div>
        )}
      </section>

      <section aria-labelledby={`${headingId}-relations`} className="flex flex-col gap-2">
        <h3 id={`${headingId}-relations`} className="text-sm font-medium text-foreground">
          {plural(model.relations.length, 'relation')}
        </h3>
        {model.relations.length === 0 ? (
          <p className="text-sm text-foreground-light">
            The read found no foreign keys between these tables.
          </p>
        ) : (
          <Table containerProps={{ 'aria-label': 'Relations between tables, scrollable' }}>
            <caption className="sr-only">Relations between tables</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="h-auto px-3 py-2">
                  Relation
                </TableHead>
                <TableHead scope="col" className="h-auto px-3 py-2">
                  From
                </TableHead>
                <TableHead scope="col" className="h-auto px-3 py-2">
                  To
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {relations.map((relation, index) => (
                <RelationRow key={relationKeys[index]} relation={relation} model={model} />
              ))}
            </TableBody>
          </Table>
        )}
        {moreRelations > 0 && (
          <div>
            <Button
              type="button"
              variant="outline"
              size="tiny"
              onClick={() => setRelationLimit(relationLimit + RELATION_VIEW_PAGE_SIZE)}
            >
              {`Show ${formatCount(Math.min(RELATION_VIEW_PAGE_SIZE, moreRelations))} more relations (${formatCount(moreRelations)} not shown)`}
            </Button>
          </div>
        )}
      </section>
    </div>
  )
}

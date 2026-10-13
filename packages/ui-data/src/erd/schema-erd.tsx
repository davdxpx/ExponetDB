// The stylesheet of the diagram is bundled with this module. React Flow injects no <style>
// element and no inline stylesheet at run time (checked in @xyflow/react 12.12.0 and
// @xyflow/system 0.0.83: no createElement('style'), insertRule or adoptedStyleSheets), so
// `style-src 'self'` holds. Only the structural base is imported; colors come from tokens.
import '@xyflow/react/dist/base.css'

import { Button, Label, Switch } from '@exponetdb/ui'
import {
  EmptyState,
  formatCount,
  ObservedTime,
  ReadableView,
  type ReadMeta,
  SourceLabel,
} from '@exponetdb/ui-patterns'
import {
  type Edge,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { type ReactNode, useId, useMemo, useState } from 'react'

import { SchemaErdTables } from './erd-table-view.tsx'
import { layoutErd, NODE_WIDTH } from './layout.ts'
import {
  buildErdModel,
  DEFAULT_MAX_COLUMNS_PER_NODE,
  DEFAULT_MAX_EDGES,
  DEFAULT_MAX_NODES,
  type ErdModel,
} from './model.ts'
import { type TableFlowNode, TableNode } from './table-node.tsx'
import type { SchemaErdData, SchemaErdProps } from './types.ts'

/** Defined once: React Flow compares the map by reference. */
const NODE_TYPES = { table: TableNode }

// React Flow 12.12.0 picks the description by the opposite of its own flag (the "keyboard
// disabled" text is used while keyboard operation is enabled), so both are the same text.
const TABLE_DESCRIPTION =
  'A table of the schema. Press Tab to move to the next table. Turn on "Show as table" to read every table, column and relation as text.'

const ARIA_LABELS = {
  'node.a11yDescription.default': TABLE_DESCRIPTION,
  'node.a11yDescription.keyboardDisabled': TABLE_DESCRIPTION,
}

const HANDLE_SIZE = 5

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`
}

function DiagramToolbar(): ReactNode {
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  return (
    <div role="toolbar" aria-label="Diagram zoom" className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="tiny" onClick={() => void zoomIn()}>
        Zoom in
      </Button>
      <Button type="button" variant="outline" size="tiny" onClick={() => void zoomOut()}>
        Zoom out
      </Button>
      <Button
        type="button"
        variant="outline"
        size="tiny"
        onClick={() => void fitView({ padding: 0.1 })}
      >
        Fit to view
      </Button>
    </div>
  )
}

function ErdDiagram({ model }: { model: ErdModel }): ReactNode {
  const baseId = useId()
  const placed = useMemo(() => layoutErd(model), [model])
  const qualifiedNames = useMemo(
    () =>
      new Map(model.nodes.map((node) => [node.nodeId, `${node.table.schema}.${node.table.name}`])),
    [model],
  )

  const nodes = useMemo(
    () =>
      model.nodes.map((entry): TableFlowNode => {
        const position = placed.get(entry.nodeId) ?? { x: 0, y: 0, width: NODE_WIDTH, height: 80 }
        const nameId = `${baseId}-${entry.nodeId}-name`
        return {
          id: entry.nodeId,
          type: 'table',
          position: { x: position.x, y: position.y },
          // A fixed size, so the layout and the drawing agree and nothing waits for a measurement.
          width: position.width,
          height: position.height,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          className: 'rounded-md focus-ring',
          draggable: false,
          selectable: false,
          connectable: false,
          deletable: false,
          // The node is named by its table name (which marks hidden characters for a reader).
          domAttributes: { 'aria-labelledby': nameId },
          handles: [
            {
              type: 'target',
              position: Position.Left,
              x: -HANDLE_SIZE / 2,
              y: position.height / 2 - HANDLE_SIZE / 2,
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
            },
            {
              type: 'source',
              position: Position.Right,
              x: position.width - HANDLE_SIZE / 2,
              y: position.height / 2 - HANDLE_SIZE / 2,
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
            },
          ],
          data: {
            entry,
            nameId,
            referenceNames: entry.references.map((id) => qualifiedNames.get(id) ?? id),
            referencedByNames: entry.referencedBy.map((id) => qualifiedNames.get(id) ?? id),
          },
        }
      }),
    [model, placed, qualifiedNames, baseId],
  )

  const edges = useMemo(
    () =>
      model.edges.map(
        (edge): Edge => ({
          id: edge.edgeId,
          source: edge.source,
          target: edge.target,
          type: 'smoothstep',
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          focusable: false,
          selectable: false,
          deletable: false,
          reconnectable: false,
          // The relations are in the node summaries and in the table view; a line is a picture.
          domAttributes: { 'aria-hidden': true },
        }),
      ),
    [model],
  )

  return (
    <ReactFlowProvider>
      <div className="flex flex-col gap-2">
        <DiagramToolbar />
        <div className="h-[36rem] min-h-[20rem] w-full overflow-hidden rounded-md border border-default bg-surface-75 [--xy-edge-stroke-selected:var(--foreground)] [--xy-edge-stroke-width:1.25] [--xy-edge-stroke:var(--muted-foreground)]">
          <ReactFlow<TableFlowNode>
            aria-label="Schema diagram"
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            ariaLabelConfig={ARIA_LABELS}
            fitView
            fitViewOptions={{ padding: 0.1, minZoom: 0.05 }}
            minZoom={0.05}
            maxZoom={2}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            edgesFocusable={false}
            deleteKeyCode={null}
            selectionKeyCode={null}
            // The wheel scrolls the page; zoom with the buttons, a pinch or Ctrl and the wheel.
            zoomOnScroll={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            // Every table stays in the DOM, so Tab reaches each one.
            onlyRenderVisibleElements={false}
            // React Flow is MIT licensed; its attribution is a request, not a license term. It is
            // an external link to reactflow.dev, which pages of ExponetDB never render (no
            // external address, and a link a person could follow out of the app). The MIT notice
            // belongs to the third-party notices of the build.
            proOptions={{ hideAttribution: true }}
          />
        </div>
      </div>
    </ReactFlowProvider>
  )
}

function DiagramNotes({
  model,
  tooMany,
  tooDense,
  maxNodes,
  maxEdges,
  maxColumnsPerNode,
  showingDiagram,
}: {
  model: ErdModel
  tooMany: boolean
  tooDense: boolean
  maxNodes: number
  maxEdges: number
  maxColumnsPerNode: number
  showingDiagram: boolean
}): ReactNode {
  const notes: string[] = []
  if (tooMany) {
    notes.push(
      `This schema has ${plural(model.nodes.length, 'table')}, more than the diagram limit of ${formatCount(maxNodes)}. Only the table view is shown.`,
    )
  }
  if (tooDense) {
    notes.push(
      `This schema has ${plural(model.edges.length, 'connection')} between tables, more than the diagram limit of ${formatCount(maxEdges)}. Only the table view is shown.`,
    )
  }
  if (showingDiagram) {
    if (model.selfRelationCount > 0) {
      notes.push(
        `${plural(model.selfRelationCount, 'relation')} from a table to itself ${model.selfRelationCount === 1 ? 'is' : 'are'} not drawn. The table view lists ${model.selfRelationCount === 1 ? 'it' : 'them'}.`,
      )
    }
    if (model.nodes.some((node) => node.hiddenColumnCount > 0)) {
      notes.push(
        `Tables with more than ${formatCount(maxColumnsPerNode)} columns show the first ${formatCount(maxColumnsPerNode)}. The table view lists all columns.`,
      )
    }
  }
  if (model.unresolvedRelationCount > 0) {
    notes.push(
      `${plural(model.unresolvedRelationCount, 'relation')} refer${model.unresolvedRelationCount === 1 ? 's' : ''} to a table this read does not list and ${model.unresolvedRelationCount === 1 ? 'is' : 'are'} not drawn. The table view lists ${model.unresolvedRelationCount === 1 ? 'it' : 'them'}.`,
    )
  }
  for (const issue of model.issues) {
    if (issue.kind === 'duplicate_table') {
      notes.push(
        `A table id appears ${formatCount(issue.dropped + 1)} times in this read. Only the first table with that id is shown.`,
      )
    }
  }
  if (notes.length === 0) return null
  return (
    <div role="note" className="rounded-md border border-default bg-surface-75 px-3 py-2 text-xs">
      <ul className="flex list-disc flex-col gap-1 pl-4 text-foreground-light">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  )
}

function ErdBody({
  data,
  meta,
  now,
  maxNodes,
  maxEdges,
  maxColumnsPerNode,
  initialView,
}: {
  data: SchemaErdData
  meta: ReadMeta
  now: SchemaErdProps['now']
  maxNodes: number
  maxEdges: number
  maxColumnsPerNode: number
  initialView: NonNullable<SchemaErdProps['initialView']>
}): ReactNode {
  const model = useMemo(() => buildErdModel(data, maxColumnsPerNode), [data, maxColumnsPerNode])
  const switchId = useId()
  const [wantsTable, setWantsTable] = useState(initialView === 'table')

  const tooMany = model.nodes.length > maxNodes
  const tooDense = model.edges.length > maxEdges
  const tableOnly = tooMany || tooDense
  const showTable = tableOnly || wantsTable

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-light">
          <SourceLabel source={meta.source} />
          <span>
            Observed <ObservedTime observedAt={meta.observedAt} now={now} withDate />
          </span>
          <span>
            {plural(model.tables.length, 'table')}, {plural(model.relations.length, 'relation')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={switchId}
            checked={showTable}
            disabled={tableOnly}
            onCheckedChange={setWantsTable}
          />
          <Label htmlFor={switchId}>Show as table</Label>
        </div>
      </div>
      <DiagramNotes
        model={model}
        tooMany={tooMany}
        tooDense={tooDense}
        maxNodes={maxNodes}
        maxEdges={maxEdges}
        maxColumnsPerNode={maxColumnsPerNode}
        showingDiagram={!showTable}
      />
      {showTable ? <SchemaErdTables model={model} /> : <ErdDiagram model={model} />}
    </div>
  )
}

/**
 * The tables and foreign keys of a schema as a diagram: each table a node (schema and name, its
 * columns with type, primary and foreign key markers), each pair of tables joined by a foreign key
 * one arrow from the table that holds the key to the one it references, laid out by dagre. Fits the
 * view at first; "Zoom in", "Zoom out" and "Fit to view" are buttons with words. The tables take
 * keyboard focus and are named by their table name.
 *
 * "Show as table" lists every table with its columns and every relation as text: the accessible
 * alternative, and the only view above the node limit (default 150 tables) or the connection
 * limit, with a note that says so. A failed read renders only the failed state (C-28). Every name
 * is untrusted text (C-26). Heavy: loads `@xyflow/react` and `@dagrejs/dagre`; load this module
 * lazily.
 */
export function SchemaErd({
  readable,
  what = 'schema diagram',
  maxNodes = DEFAULT_MAX_NODES,
  maxEdges = DEFAULT_MAX_EDGES,
  maxColumnsPerNode = DEFAULT_MAX_COLUMNS_PER_NODE,
  initialView = 'diagram',
  onRetry,
  onRefresh,
  busy,
  now,
  headingLevel,
  className,
}: SchemaErdProps): ReactNode {
  return (
    <ReadableView
      readable={readable}
      what={what}
      onRetry={onRetry}
      onRefresh={onRefresh}
      busy={busy}
      now={now}
      headingLevel={headingLevel}
      className={className}
      empty={{
        isEmpty: (data) => data.tables.length === 0,
        content: (
          <EmptyState
            title="No tables"
            description="The read succeeded and found no tables to draw."
            headingLevel={headingLevel}
          />
        ),
      }}
      ready={(data, meta) => (
        <ErdBody
          data={data}
          meta={meta}
          now={now}
          maxNodes={maxNodes}
          maxEdges={maxEdges}
          maxColumnsPerNode={maxColumnsPerNode}
          initialView={initialView}
        />
      )}
    />
  )
}

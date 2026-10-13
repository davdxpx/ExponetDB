import { Database, Server } from '@exponetdb/icons'
import { flattenTree, type INodeRendererProps, TreeView, TreeViewItem } from '@exponetdb/ui'
import { UntrustedName } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { HOSTILE } from './support.tsx'

/** One row of a tree: the props the library passes, plus what the row shows. */
function Node({
  node,
  name,
  icon,
}: {
  readonly node: INodeRendererProps
  readonly name: ReactNode
  readonly icon?: ReactNode
}): ReactNode {
  return (
    <TreeViewItem
      {...node.getNodeProps()}
      name={name}
      icon={icon}
      level={node.level}
      isBranch={node.isBranch}
      isExpanded={node.isExpanded}
      isSelected={node.isSelected}
      setsize={node.setsize}
      posinset={node.posinset}
      isDisabled={node.isDisabled}
      isHalfSelected={node.isHalfSelected}
      handleSelect={node.handleSelect}
      handleExpand={node.handleExpand}
      treeState={node.treeState}
      dispatch={node.dispatch}
    />
  )
}

const SCHEMAS = flattenTree({
  name: '',
  children: [
    {
      name: 'public',
      children: [{ name: 'orders' }, { name: 'customers' }, { name: 'payments' }],
    },
    { name: 'exponetdb', children: [{ name: 'ledger' }, { name: 'target_identity' }] },
  ],
})

function Schemas(): ReactNode {
  return (
    <div className="max-w-xs rounded-md border border-default py-1">
      <TreeView
        data={SCHEMAS}
        aria-label="Schemas"
        defaultExpandedIds={[1]}
        defaultSelectedIds={[3]}
        nodeRenderer={(node) => <Node node={node} name={<span>{node.element.name}</span>} />}
      />
    </div>
  )
}

const FLEET = flattenTree({
  name: '',
  children: [
    {
      name: 'pg-main',
      children: [{ name: 'shop/platform/staging' }, { name: 'shop/platform/production' }],
    },
    { name: 'pg-reports', children: [{ name: 'acme/billing/staging' }] },
  ],
})

function Icons(): ReactNode {
  return (
    <div className="max-w-xs rounded-md border border-default py-1">
      <TreeView
        data={FLEET}
        aria-label="Clusters and their targets"
        defaultExpandedIds={[1, 4]}
        nodeRenderer={(node) => (
          <Node
            node={node}
            name={<span>{node.element.name}</span>}
            icon={
              node.isBranch ? (
                <Server aria-hidden className="size-4" />
              ) : (
                <Database aria-hidden className="size-4" />
              )
            }
          />
        )}
      />
    </div>
  )
}

const HOSTILE_TREE = flattenTree({
  name: '',
  children: [
    { name: HOSTILE.bidi, children: [{ name: HOSTILE.zeroWidth }, { name: HOSTILE.markup }] },
  ],
})

function Untrusted(): ReactNode {
  return (
    <div className="max-w-sm rounded-md border border-default py-1">
      <TreeView
        data={HOSTILE_TREE}
        aria-label="Objects with hostile names"
        defaultExpandedIds={[1]}
        // The name goes through UntrustedName, so no `title` is derived from the raw string.
        nodeRenderer={(node) => (
          <Node node={node} name={<UntrustedName name={node.element.name} mono />} />
        )}
      />
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/tree-view/schemas',
    title: 'A schema tree with a selected item',
    render: () => <Schemas />,
  },
  {
    id: 'ui/tree-view/icons',
    title: 'Branches and leaves with their own icons',
    render: () => <Icons />,
  },
  {
    id: 'ui/tree-view/untrusted',
    title: 'Hostile names shown through UntrustedName',
    render: () => <Untrusted />,
  },
]

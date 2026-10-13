import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { UntrustedName } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { Observation } from './live-read.tsx'
import {
  type BlockingTree,
  buildBlockingTree,
  formatWait,
  type LockGraph,
  type TreeNode,
  waitMillis,
} from './model.ts'

/**
 * The lock graph of a target: who blocks whom as a tree (a process that holds
 * a lock at the root, the processes that wait for it below) and every wait as
 * a table row with its lock mode, relation and wait time. Relation names come
 * from the target's catalog and are untrusted text; nothing here is a link or
 * a button that acts on a session.
 */
export function LockGraphView(props: {
  readonly graph: LockGraph
  readonly headingLevel: 3 | 4
}): ReactNode {
  const { graph } = props
  const tree = buildBlockingTree(graph.waits)
  const Heading = props.headingLevel === 3 ? 'h3' : 'h4'
  return (
    <div className="flex flex-col gap-4" data-lock-graph="">
      <Observation source={graph.source} observedAt={graph.observedAt} />
      <section aria-labelledby="lock-tree-title" className="flex flex-col gap-2">
        <Heading id="lock-tree-title" className="text-sm font-medium text-foreground">
          {t('locks.tree.title')}
        </Heading>
        <TreeView tree={tree} observedAt={graph.observedAt} />
      </section>
      <section aria-labelledby="lock-table-title" className="flex flex-col gap-2">
        <Heading id="lock-table-title" className="text-sm font-medium text-foreground">
          {t('locks.table.title')}
        </Heading>
        <Table>
          <TableCaption className="sr-only">{t('locks.table.caption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('locks.column.blocked')}</TableHead>
              <TableHead scope="col">{t('locks.column.blocking')}</TableHead>
              <TableHead scope="col">{t('locks.column.mode')}</TableHead>
              <TableHead scope="col">{t('locks.column.relation')}</TableHead>
              <TableHead scope="col">{t('locks.column.wait')}</TableHead>
              <TableHead scope="col">{t('locks.column.operation')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {graph.waits.map((wait) => (
              <TableRow key={wait.waitingPid} data-wait-pid={wait.waitingPid}>
                <TableCell className="font-mono text-xs">{wait.waitingPid}</TableCell>
                <TableCell className="font-mono text-xs">
                  {[...wait.blockingPids].sort((a, b) => a - b).join(', ')}
                </TableCell>
                <TableCell>
                  <UntrustedName name={wait.lockMode} mono label={t('locks.column.mode')} />
                </TableCell>
                <TableCell>
                  {wait.relation === null ? (
                    t('locks.relation.none')
                  ) : (
                    <UntrustedName name={wait.relation} mono label={t('locks.column.relation')} />
                  )}
                </TableCell>
                <TableCell>{formatWait(waitMillis(wait, graph.observedAt))}</TableCell>
                <TableCell>
                  {wait.exponetdbOperationId === null ? (
                    t('connections.operation.none')
                  ) : (
                    <UntrustedName
                      name={wait.exponetdbOperationId}
                      mono
                      label={t('locks.column.operation')}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  )
}

function TreeView(props: { readonly tree: BlockingTree; readonly observedAt: string }): ReactNode {
  const { tree, observedAt } = props
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label={t('locks.tree.caption')} className="flex flex-col gap-2 text-sm">
        {tree.roots.map((node) => (
          <TreeItem key={node.pid} node={node} observedAt={observedAt} />
        ))}
      </ul>
      {tree.cycles.length === 0 ? null : (
        <div data-lock-cycle="" className="flex flex-col gap-1">
          <p className="text-sm text-foreground-light">{t('locks.tree.cycle')}</p>
          <ul className="flex flex-col gap-2 text-sm">
            {tree.cycles.map((node) => (
              <TreeItem key={node.pid} node={node} observedAt={observedAt} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function TreeItem(props: { readonly node: TreeNode; readonly observedAt: string }): ReactNode {
  const { node, observedAt } = props
  const wait = node.wait
  const line =
    wait === undefined
      ? t('locks.tree.root', { pid: node.pid })
      : waitSentence(node.pid, formatWait(waitMillis(wait, observedAt)), wait.waitingSince !== null)
  return (
    <li data-pid={node.pid} className="rounded-md border border-default px-3 py-2">
      <span>{line}</span>
      {wait === undefined ? null : (
        <span className="text-foreground-light">
          {' '}
          (<UntrustedName name={wait.lockMode} mono label={t('locks.column.mode')} />
          {wait.relation === null ? null : (
            <>
              {', '}
              <UntrustedName name={wait.relation} mono label={t('locks.column.relation')} />
            </>
          )}
          )
        </span>
      )}
      {node.alsoBlockedBy.length === 0 ? null : (
        <span className="block text-xs text-foreground-light">
          {t('locks.tree.alsoBlockedBy', { pids: node.alsoBlockedBy.join(', ') })}
        </span>
      )}
      {node.children.length === 0 ? null : (
        <ul className="mt-2 flex flex-col gap-2 border-l border-default pl-4">
          {node.children.map((child) => (
            <TreeItem key={child.pid} node={child} observedAt={observedAt} />
          ))}
        </ul>
      )}
    </li>
  )
}

function waitSentence(pid: number, wait: string, known: boolean): string {
  return known ? t('locks.tree.waiting', { pid, wait }) : t('locks.tree.waitingUnknown', { pid })
}

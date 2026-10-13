import {
  Checkbox,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableHeadSort,
  TableRow,
} from '@exponetdb/ui'
import { StateBadge, TierChip, UntrustedName } from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { HOSTILE } from './support.tsx'

interface TargetRow {
  readonly path: string
  readonly tier: 'prod' | 'nonprod'
  readonly size: number
  readonly migrations: number
}

const TARGETS: readonly TargetRow[] = [
  { path: 'shop/platform/staging', tier: 'nonprod', size: 4.2, migrations: 38 },
  { path: 'shop/platform/production', tier: 'prod', size: 61.8, migrations: 37 },
  { path: 'acme/billing/staging', tier: 'nonprod', size: 1.1, migrations: 12 },
]

function Basic(): ReactNode {
  return (
    <Table>
      <TableCaption>Three targets. Sizes are the last measured values.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Target</TableHead>
          <TableHead scope="col">Tier</TableHead>
          <TableHead scope="col" className="text-right">
            Size (GB)
          </TableHead>
          <TableHead scope="col" className="text-right">
            Migrations
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {TARGETS.map((target) => (
          <TableRow key={target.path}>
            <TableCell className="font-mono text-xs">{target.path}</TableCell>
            <TableCell>
              <TierChip tier={target.tier} />
            </TableCell>
            <TableCell className="text-right tabular-nums">{target.size.toFixed(1)}</TableCell>
            <TableCell className="text-right tabular-nums">{target.migrations}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={2}>Total</TableCell>
          <TableCell className="text-right tabular-nums">67.1</TableCell>
          <TableCell className="text-right tabular-nums">87</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  )
}

type SortKey = 'path' | 'size'

function Sortable(): ReactNode {
  const [sort, setSort] = useState('size:desc')
  const separator = sort.lastIndexOf(':')
  const column = sort.slice(0, separator)
  const direction = sort.slice(separator + 1)
  const sorted = [...TARGETS].sort((a, b) => {
    const order = column === 'size' ? a.size - b.size : a.path.localeCompare(b.path, 'en-US')
    return direction === 'desc' ? -order : order
  })
  const change = (next: SortKey) =>
    setSort((current) =>
      current === `${next}:asc` ? `${next}:desc` : current === `${next}:desc` ? '' : `${next}:asc`,
    )
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">
            <TableHeadSort column="path" currentSort={sort} onSortChange={change}>
              Target
            </TableHeadSort>
          </TableHead>
          <TableHead scope="col" className="text-right">
            <TableHeadSort
              column="size"
              currentSort={sort}
              onSortChange={change}
              className="justify-end"
            >
              Size (GB)
            </TableHeadSort>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((target) => (
          <TableRow key={target.path}>
            <TableCell className="font-mono text-xs">{target.path}</TableCell>
            <TableCell className="text-right tabular-nums">{target.size.toFixed(1)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Selectable(): ReactNode {
  const [chosen, setChosen] = useState<readonly string[]>(['acme/billing/staging'])
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="w-10">
            <Checkbox
              aria-label="Choose all targets"
              checked={
                chosen.length === TARGETS.length
                  ? true
                  : chosen.length > 0
                    ? 'indeterminate'
                    : false
              }
              onCheckedChange={(next) =>
                setChosen(next === true ? TARGETS.map((target) => target.path) : [])
              }
            />
          </TableHead>
          <TableHead scope="col">Target</TableHead>
          <TableHead scope="col">State</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {TARGETS.map((target, index) => (
          <TableRow
            key={target.path}
            data-state={chosen.includes(target.path) ? 'selected' : undefined}
          >
            <TableCell>
              <Checkbox
                aria-label={`Choose ${target.path}`}
                checked={chosen.includes(target.path)}
                onCheckedChange={(next) =>
                  setChosen((current) =>
                    next === true
                      ? [...current, target.path]
                      : current.filter((path) => path !== target.path),
                  )
                }
              />
            </TableCell>
            <TableCell className="font-mono text-xs">{target.path}</TableCell>
            <TableCell>
              <StateBadge state={index === 2 ? 'stale' : 'healthy'} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Untrusted(): ReactNode {
  const names = [
    { label: 'A right-to-left override', value: HOSTILE.bidi },
    { label: 'A zero-width space', value: HOSTILE.zeroWidth },
    { label: 'A line break', value: HOSTILE.lineBreak },
    { label: 'Markup', value: HOSTILE.markup },
  ] as const
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">What the name contains</TableHead>
          <TableHead scope="col">The name, through UntrustedName</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {names.map((entry) => (
          <TableRow key={entry.label}>
            <TableCell>{entry.label}</TableCell>
            <TableCell className="font-mono text-xs">
              <UntrustedName name={entry.value} mono />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Wide(): ReactNode {
  return (
    <div className="w-72 max-w-full">
      <Table
        containerProps={{ 'aria-label': 'Targets, scrolls sideways' }}
        className="min-w-[40rem]"
      >
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Target</TableHead>
            <TableHead scope="col">Cluster</TableHead>
            <TableHead scope="col">Version</TableHead>
            <TableHead scope="col">Last backup</TableHead>
            <TableHead scope="col">Last migration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="font-mono text-xs">shop/platform/staging</TableCell>
            <TableCell>pg-main</TableCell>
            <TableCell>PostgreSQL 17.2</TableCell>
            <TableCell>4 hours ago</TableCell>
            <TableCell>01JA8Q3M5T7V9XBZC4D6E8F0GH</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/table/basic',
    title: 'A table with a caption, aligned numbers and a total',
    render: () => <Basic />,
  },
  {
    id: 'ui/table/sortable',
    title: 'Sortable columns: the header reports the sort state',
    render: () => <Sortable />,
  },
  {
    id: 'ui/table/selectable',
    title: 'Selectable rows with a select-all checkbox',
    render: () => <Selectable />,
  },
  {
    id: 'ui/table/untrusted',
    title: 'Hostile names in cells, shown through UntrustedName',
    render: () => <Untrusted />,
  },
  {
    id: 'ui/table/wide',
    title: 'A table wider than its container scrolls inside a named region',
    render: () => <Wide />,
  },
]

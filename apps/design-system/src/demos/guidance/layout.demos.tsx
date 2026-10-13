import {
  Button,
  Card,
  CardContent,
  cn,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  PageBreadcrumbs,
  PageBreadcrumbsActions,
  PageContainer,
  PageNav,
  PageSection,
  PageSectionAside,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
  StateBadge,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { NOW, OBSERVED } from './support.tsx'

/** The four sizes of `PageContainer` with the share of the widest one each takes. */
const WIDTHS = [
  {
    size: 'small',
    limit: '768 px',
    bar: 'w-[48%]',
    use: 'Settings and focused forms',
    dashed: false,
  },
  {
    size: 'default',
    limit: '1200 px',
    bar: 'w-3/4',
    use: 'Detail pages and plan review',
    dashed: false,
  },
  {
    size: 'large',
    limit: '1600 px',
    bar: 'w-full',
    use: 'Lists and tables',
    dashed: false,
  },
  {
    size: 'full',
    limit: 'no limit',
    bar: 'w-full',
    use: 'Work surfaces: editor, timeline, grid',
    dashed: true,
  },
] as const

function WidthTable(): ReactNode {
  return (
    <ul className="m-0 flex list-none flex-col gap-4 p-0" aria-label="Page container sizes">
      {WIDTHS.map((width) => (
        <li key={width.size} className="flex flex-col gap-1.5">
          <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span>
              <code className="font-mono text-foreground">{width.size}</code>
              <span className="text-foreground-light">: {width.use}</span>
            </span>
            <span className="text-xs text-foreground-lighter">{width.limit}</span>
          </p>
          <div
            aria-hidden="true"
            className={cn(
              'h-3 rounded-sm',
              width.bar,
              width.dashed
                ? 'border border-dashed border-strong bg-transparent'
                : 'bg-primary-solid opacity-80',
            )}
          />
        </li>
      ))}
    </ul>
  )
}

const OPERATIONS = [
  { id: 'op_01K9D4', what: 'Apply 2 migrations', state: 'healthy', when: '14 minutes ago' },
  { id: 'op_01K9C7', what: 'Verify migration', state: 'degraded', when: '2 hours ago' },
] as const

function PageChrome(): ReactNode {
  return (
    <div className="overflow-hidden rounded-md border border-default">
      <PageBreadcrumbs
        items={[
          { label: 'Databases', href: '#databases' },
          { label: 'shop', href: '#shop' },
          { label: 'platform', href: '#platform' },
          { label: 'staging' },
        ]}
        actions={
          <PageBreadcrumbsActions>
            <Button variant="primary" size="tiny">
              Draft a change
            </Button>
          </PageBreadcrumbsActions>
        }
      />
      <PageNav
        label="Target sections"
        items={[
          { label: 'Overview', href: '#overview', active: true },
          { label: 'Migrations', href: '#migrations', active: false },
          { label: 'Connections', href: '#connections', active: false },
        ]}
      />
      <PageContainer size="default" className="pb-8">
        <PageSection>
          <PageSectionMeta>
            <PageSectionSummary>
              <PageSectionTitle>Recent operations</PageSectionTitle>
              <PageSectionDescription>
                Operations on this target, newest first.
              </PageSectionDescription>
            </PageSectionSummary>
            <PageSectionAside>
              <Button variant="default" size="tiny">
                View all operations
              </Button>
            </PageSectionAside>
          </PageSectionMeta>
          <PageSectionContent>
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Operation</TableHead>
                    <TableHead scope="col">What</TableHead>
                    <TableHead scope="col">State</TableHead>
                    <TableHead scope="col">Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {OPERATIONS.map((operation) => (
                    <TableRow key={operation.id}>
                      <TableCell className="font-mono text-xs">{operation.id}</TableCell>
                      <TableCell>{operation.what}</TableCell>
                      <TableCell>
                        <StateBadge
                          state={operation.state}
                          source="live"
                          observedAt={OBSERVED}
                          now={NOW}
                        />
                      </TableCell>
                      <TableCell className="text-foreground-light">{operation.when}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </PageSectionContent>
        </PageSection>
      </PageContainer>
    </div>
  )
}

function SectionOrientation(): ReactNode {
  return (
    <PageContainer size="small" className="px-0 xl:px-0">
      <PageSection orientation="horizontal" className="pt-0">
        <PageSectionSummary>
          <PageSectionTitle>Approvals</PageSectionTitle>
          <PageSectionDescription>
            Who must approve a plan before it can be applied to this product.
          </PageSectionDescription>
        </PageSectionSummary>
        <PageSectionContent>
          <Card>
            <CardContent>
              <p className="m-0 text-sm text-foreground-light">
                One approval from a person who did not create the plan.
              </p>
            </CardContent>
          </Card>
        </PageSectionContent>
      </PageSection>
    </PageContainer>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/layout/widths',
    title: 'The four container sizes, drawn to the same scale',
    render: () => <WidthTable />,
  },
  {
    id: 'guidance/layout/page-chrome',
    title: 'Breadcrumbs, sub-navigation and a section, top to bottom',
    render: () => <PageChrome />,
  },
  {
    id: 'guidance/layout/horizontal-section',
    title: 'A section with its summary beside the content',
    render: () => <SectionOrientation />,
  },
]

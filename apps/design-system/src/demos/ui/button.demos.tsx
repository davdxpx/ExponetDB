import { Copy, Plus, RefreshCw, Trash2 } from '@exponetdb/icons'
import {
  Button,
  ButtonGroup,
  ButtonGroupItem,
  FloatingPlate,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exponetdb/ui'
import { useLinkComponent } from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Specimen, Stack } from './support.tsx'

function Variants(): ReactNode {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
      <Specimen caption="primary">
        <Button variant="primary">Create plan</Button>
      </Specimen>
      <Specimen caption="default">
        <Button variant="default">Cancel</Button>
      </Specimen>
      <Specimen caption="secondary">
        <Button variant="secondary">Copy plan hash</Button>
      </Specimen>
      <Specimen caption="outline">
        <Button variant="outline">Add filter</Button>
      </Specimen>
      <Specimen caption="dashed">
        <Button variant="dashed" icon={<Plus />}>
          Add target
        </Button>
      </Specimen>
      <Specimen caption="text">
        <Button variant="text">Dismiss</Button>
      </Specimen>
      <Specimen caption="link">
        <Button variant="link">Open audit</Button>
      </Specimen>
      <Specimen caption="danger">
        <Button variant="danger">Withdraw plan</Button>
      </Specimen>
      <Specimen caption="warning">
        <Button variant="warning">Apply with warnings</Button>
      </Specimen>
    </div>
  )
}

function Sizes(): ReactNode {
  return (
    <Row className="items-end">
      {(['tiny', 'small', 'medium', 'large'] as const).map((size) => (
        <Specimen key={size} caption={size}>
          <Button size={size} variant="primary">
            Create plan
          </Button>
        </Specimen>
      ))}
    </Row>
  )
}

function Icons(): ReactNode {
  return (
    <Stack>
      <Row>
        <Button icon={<Plus />}>Add target</Button>
        <Button iconRight={<RefreshCw />}>Refresh</Button>
        <Button variant="default" icon={<Copy />}>
          Copy path
        </Button>
        <Button variant="primary" rounded>
          Create plan
        </Button>
      </Row>
      <Row>
        <Button aria-label="Copy plan hash" icon={<Copy />} />
        <Button aria-label="Refresh" size="small" icon={<RefreshCw />} />
        <Button aria-label="Delete role" variant="text" size="medium" icon={<Trash2 />} />
        <Button aria-label="Add target" variant="outline" size="large" icon={<Plus />} />
      </Row>
    </Stack>
  )
}

function States(): ReactNode {
  return (
    <Stack>
      <Row>
        <Button variant="primary" disabled>
          Create plan
        </Button>
        <Button variant="default" disabled>
          Cancel
        </Button>
        <Button variant="primary" loading>
          Applying plan
        </Button>
        <Button variant="default" loading>
          Verifying
        </Button>
      </Row>
      <Row>
        <Button variant="primary" block>
          Approve plan
        </Button>
      </Row>
    </Stack>
  )
}

function Explained(): ReactNode {
  const [clicks, setClicks] = useState(0)
  return (
    <Stack>
      <Row>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="primary"
              disabled
              focusableWhenDisabled
              onClick={() => setClicks((current) => current + 1)}
            >
              Apply plan
            </Button>
          </TooltipTrigger>
          <TooltipContent>The plan is waiting for approval.</TooltipContent>
        </Tooltip>
        <p className="text-sm text-foreground-light">Clicks that reached the handler: {clicks}</p>
      </Row>
      <p className="text-sm text-foreground-light">
        Focus the button with Tab: it stays reachable, shows the reason in a tooltip and swallows
        Enter, Space and clicks.
      </p>
    </Stack>
  )
}

function AsLink(): ReactNode {
  const Link = useLinkComponent()
  return (
    <Row>
      <Button asChild variant="default">
        <Link href="/ui/dialog">Open the dialog page</Link>
      </Button>
      <Button asChild variant="link" iconRight={<Plus />}>
        <Link href="/ui/sheet">Open the sheet page</Link>
      </Button>
    </Row>
  )
}

function Group(): ReactNode {
  return (
    <div className="w-64">
      <ButtonGroup aria-label="Target actions">
        <ButtonGroupItem icon={<Copy />}>Copy path</ButtonGroupItem>
        <ButtonGroupItem icon={<RefreshCw />}>Refresh</ButtonGroupItem>
        <ButtonGroupItem icon={<Trash2 />}>Withdraw plan</ButtonGroupItem>
      </ButtonGroup>
    </div>
  )
}

function Floating(): ReactNode {
  return (
    <div className="relative max-w-md overflow-hidden rounded-md border border-default bg-card p-4">
      <pre className="font-mono text-xs text-foreground-light">
        {`CREATE INDEX CONCURRENTLY orders_customer_id_idx
  ON orders (customer_id);

ANALYZE orders;`}
      </pre>
      <FloatingPlate className="absolute top-2 right-2">
        <Button aria-label="Copy statement" size="tiny" icon={<Copy />} />
      </FloatingPlate>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  { id: 'ui/button/variants', title: 'The nine variants', render: () => <Variants /> },
  { id: 'ui/button/sizes', title: 'The four sizes', render: () => <Sizes /> },
  {
    id: 'ui/button/icons',
    title: 'Icons, pill shape and icon-only buttons',
    render: () => <Icons />,
  },
  {
    id: 'ui/button/states',
    title: 'Disabled, loading and full width',
    render: () => <States />,
  },
  {
    id: 'ui/button/explained',
    title: 'Disabled with a reason: focusable and explained',
    render: () => <Explained />,
  },
  {
    id: 'ui/button/as-link',
    title: 'A link that looks like a button (asChild)',
    render: () => <AsLink />,
  },
  { id: 'ui/button/group', title: 'A group of related actions', render: () => <Group /> },
  {
    id: 'ui/button/floating-plate',
    title: 'A floating plate keeps a button readable over content',
    render: () => <Floating />,
  },
]

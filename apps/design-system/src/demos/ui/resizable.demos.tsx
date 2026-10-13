import {
  Button,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef,
} from '@exponetdb/ui'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function Pane({
  title,
  children,
}: {
  readonly title: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="flex h-full flex-col gap-1 p-3">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-sm text-foreground-light">{children}</p>
    </div>
  )
}

function Horizontal(): ReactNode {
  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-40 max-w-xl rounded-md border border-default"
    >
      <ResizablePanel id="schema" defaultSize="35%" minSize="20%" maxSize="60%">
        <Pane title="Schema">Tables, views and functions.</Pane>
      </ResizablePanel>
      <ResizableHandle withHandle aria-label="Resize the schema list" />
      <ResizablePanel id="definition" defaultSize="65%" minSize="30%">
        <Pane title="Definition">The selected object.</Pane>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function Nested(): ReactNode {
  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-52 max-w-xl rounded-md border border-default"
    >
      <ResizablePanel id="list" defaultSize="30%" minSize="15%">
        <Pane title="Targets">Choose one.</Pane>
      </ResizablePanel>
      <ResizableHandle withHandle aria-label="Resize the target list" />
      <ResizablePanel id="detail" defaultSize="70%">
        <ResizablePanelGroup orientation="vertical">
          <ResizablePanel id="overview" defaultSize="60%" minSize="25%">
            <Pane title="Overview">Health, version and placement.</Pane>
          </ResizablePanel>
          <ResizableHandle withHandle aria-label="Resize the overview" />
          <ResizablePanel id="activity" defaultSize="40%" minSize="20%">
            <Pane title="Activity">Recent operations.</Pane>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function Collapsible(): ReactNode {
  const panel = usePanelRef()
  return (
    <Stack>
      <Row>
        <Button variant="default" onClick={() => panel.current?.collapse()}>
          Collapse the list
        </Button>
        <Button variant="default" onClick={() => panel.current?.expand()}>
          Expand the list
        </Button>
      </Row>
      <ResizablePanelGroup
        orientation="horizontal"
        className="h-40 max-w-xl rounded-md border border-default"
      >
        <ResizablePanel
          id="menu"
          panelRef={panel}
          collapsible
          collapsedSize="0%"
          defaultSize="30%"
          minSize="15%"
        >
          <Pane title="Sections">Overview, schema and migrations.</Pane>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize the section list" />
        <ResizablePanel id="page" defaultSize="70%">
          <Pane title="Page">Drag the handle or use the arrow keys.</Pane>
        </ResizablePanel>
      </ResizablePanelGroup>
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/resizable/horizontal',
    title: 'Two panels with limits and a labelled handle',
    render: () => <Horizontal />,
  },
  {
    id: 'ui/resizable/nested',
    title: 'A vertical group nested in a horizontal one',
    render: () => <Nested />,
  },
  {
    id: 'ui/resizable/collapsible',
    title: 'A collapsible panel, driven by buttons and by the handle',
    render: () => <Collapsible />,
  },
]

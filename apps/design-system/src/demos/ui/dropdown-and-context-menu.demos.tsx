import { ChevronDown } from '@exponetdb/icons'
import {
  Button,
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@exponetdb/ui'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function Actions(): ReactNode {
  const [showDetails, setShowDetails] = useState(true)
  const [tier, setTier] = useState('all')
  const [last, setLast] = useState('Nothing chosen yet.')
  return (
    <Stack>
      <Row>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="default" iconRight={<ChevronDown />}>
              Target actions
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>shop/platform/staging</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => setLast('Path copied.')}>
                Copy path
                <DropdownMenuShortcut>C</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLast('Opened the audit trail.')}>
                Open audit trail
              </DropdownMenuItem>
              <DropdownMenuItem disabled>Open SQL (needs a permission)</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={showDetails} onCheckedChange={setShowDetails}>
              Show details
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Environments</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={tier} onValueChange={setTier}>
              <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="nonprod">Non-production</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="prod">Production</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Export</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={() => setLast('Exported as JSON.')}>
                  As JSON
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setLast('Exported as CSV.')}>
                  As CSV
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setLast('Started a plan to withdraw.')}>
              Withdraw plan
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <p role="status" className="text-sm text-foreground-light">
          {last} Details {showDetails ? 'shown' : 'hidden'}; environments: {tier}.
        </p>
      </Row>
    </Stack>
  )
}

function RowMenu(): ReactNode {
  const [last, setLast] = useState('Nothing chosen yet.')
  return (
    <Stack>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex w-full max-w-md items-center justify-between gap-3 rounded-md border border-default px-3 py-2 text-sm">
            <span className="font-mono text-xs">shop/platform/staging</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="text" size="tiny" iconRight={<ChevronDown />}>
                  Actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setLast('Path copied.')}>
                  Copy path
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setLast('Opened the audit trail.')}>
                  Open audit trail
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>shop/platform/staging</ContextMenuLabel>
          <ContextMenuItem onSelect={() => setLast('Path copied.')}>
            Copy path
            <ContextMenuShortcut>C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setLast('Opened the audit trail.')}>
            Open audit trail
          </ContextMenuItem>
          <ContextMenuCheckboxItem checked onCheckedChange={() => setLast('Toggled details.')}>
            Show details
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>
      <p className="text-sm text-foreground-light">
        Right-click the row, or press the context-menu key or Shift+F10 on it. The same actions are
        in the Actions button: the context menu is a shortcut, never the only way.
      </p>
      <p role="status" className="text-sm text-foreground-lighter">
        {last}
      </p>
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/dropdown-and-context-menu/dropdown',
    title: 'A menu with groups, a checkbox, radios, a submenu and a last, separate action',
    render: () => <Actions />,
    visual: false,
  },
  {
    id: 'ui/dropdown-and-context-menu/row',
    title: 'A row with an Actions button and the same actions in a context menu',
    render: () => <RowMenu />,
    visual: false,
  },
]

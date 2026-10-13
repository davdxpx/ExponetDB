import { Database, GitCompareArrows, ScrollText } from '@exponetdb/icons'
import {
  Button,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@exponetdb/ui'
import { UntrustedName } from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { HOSTILE, Row } from './support.tsx'

function Inline(): ReactNode {
  const [last, setLast] = useState('Nothing chosen yet.')
  return (
    <div className="flex flex-col gap-2">
      <Command label="Search commands" className="h-72 max-w-md rounded-md border border-default">
        <CommandInput placeholder="Search commands" />
        <CommandList>
          <CommandEmpty>No command matches.</CommandEmpty>
          <CommandGroup heading="Go to">
            <CommandItem onSelect={() => setLast('Go to Databases.')}>
              <Database aria-hidden className="mr-2 size-4" />
              Databases
              <CommandShortcut>G then T</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => setLast('Go to Changes.')}>
              <GitCompareArrows aria-hidden className="mr-2 size-4" />
              Changes
              <CommandShortcut>G then C</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => setLast('Go to Audit.')}>
              <ScrollText aria-hidden className="mr-2 size-4" />
              Audit
              <CommandShortcut>G then U</CommandShortcut>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Targets">
            <CommandItem onSelect={() => setLast('Opened shop/platform/staging.')}>
              shop/platform/staging
            </CommandItem>
            <CommandItem onSelect={() => setLast('Opened shop/platform/production.')}>
              shop/platform/production
            </CommandItem>
            <CommandItem disabled>acme/billing/staging (no access)</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
      <p role="status" className="text-xs text-foreground-lighter">
        {last}
      </p>
    </div>
  )
}

function Dialog(): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <Row>
      <Button variant="default" onClick={() => setOpen(true)}>
        Open the command menu
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command menu"
        description="Type to search, use the arrow keys to choose and press Enter to run."
      >
        <CommandInput placeholder="Search commands" />
        <CommandList>
          <CommandEmpty>No command matches.</CommandEmpty>
          <CommandGroup heading="Go to">
            <CommandItem onSelect={() => setOpen(false)}>Databases</CommandItem>
            <CommandItem onSelect={() => setOpen(false)}>Changes</CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </Row>
  )
}

function Untrusted(): ReactNode {
  return (
    <Command label="Search targets" className="h-60 max-w-md rounded-md border border-default">
      <CommandInput placeholder="Search by path" />
      <CommandList>
        <CommandEmpty>No target matches.</CommandEmpty>
        <CommandGroup heading="Targets">
          {[HOSTILE.bidi, HOSTILE.zeroWidth, HOSTILE.markup].map((name) => (
            <CommandItem key={name} value={name}>
              <UntrustedName name={name} mono />
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/command/inline',
    title: 'A filterable command list with groups, shortcut hints and a disabled item',
    render: () => <Inline />,
  },
  {
    id: 'ui/command/dialog',
    title: 'The command list in a dialog',
    render: () => <Dialog />,
    visual: false,
  },
  {
    id: 'ui/command/untrusted',
    title: 'Names from a database are shown through UntrustedName',
    render: () => <Untrusted />,
  },
]

import {
  Button,
  ComboboxTrigger,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@exponetdb/ui'
import { type ReactNode, useId, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function Basic(): ReactNode {
  const id = useId()
  return (
    <div className="flex w-64 flex-col gap-1.5">
      <Label htmlFor={id} className="text-foreground-light">
        Environment
      </Label>
      <Select defaultValue="staging">
        <SelectTrigger id={id}>
          <SelectValue placeholder="Choose an environment" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="development">development</SelectItem>
          <SelectItem value="staging">staging</SelectItem>
          <SelectItem value="production">production</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

function Sizes(): ReactNode {
  return (
    <Stack className="w-64">
      {(['tiny', 'small', 'medium', 'large'] as const).map((size) => (
        <Select key={size} defaultValue="staging">
          <SelectTrigger size={size} aria-label={`Environment, ${size}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="staging">staging</SelectItem>
            <SelectItem value="production">production</SelectItem>
          </SelectContent>
        </Select>
      ))}
    </Stack>
  )
}

function States(): ReactNode {
  const errorId = useId()
  return (
    <Stack className="w-64">
      <Select>
        <SelectTrigger aria-label="Environment, nothing chosen">
          <SelectValue placeholder="Choose an environment" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="staging">staging</SelectItem>
        </SelectContent>
      </Select>
      <Select defaultValue="production" disabled>
        <SelectTrigger aria-label="Environment, disabled">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="production">production</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex flex-col gap-1.5">
        <Select>
          <SelectTrigger aria-label="Cluster" aria-invalid="true" aria-describedby={errorId}>
            <SelectValue placeholder="Choose a cluster" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pg-main">pg-main</SelectItem>
          </SelectContent>
        </Select>
        <p id={errorId} role="alert" className="text-sm text-destructive">
          Choose the cluster that hosts the target.
        </p>
      </div>
    </Stack>
  )
}

function Grouped(): ReactNode {
  return (
    <div className="w-64">
      <Select defaultValue="nonprod-staging">
        <SelectTrigger aria-label="Environment, grouped by tier">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Non-production</SelectLabel>
            <SelectItem value="nonprod-development">development</SelectItem>
            <SelectItem value="nonprod-staging">staging</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Production</SelectLabel>
            <SelectItem value="prod-production">production</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

const TARGETS = ['shop/platform/staging', 'shop/platform/production', 'acme/billing/staging']

function Searchable(): ReactNode {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState<string | undefined>(undefined)
  return (
    <Row>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <ComboboxTrigger
            className="w-72"
            aria-label="Target"
            aria-expanded={open}
            data-placeholder={value === undefined ? '' : undefined}
          >
            {value ?? 'Choose a target'}
          </ComboboxTrigger>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command label="Search targets">
            <CommandInput placeholder="Search by path" />
            <CommandList>
              <CommandEmpty>No target matches.</CommandEmpty>
              <CommandGroup>
                {TARGETS.map((target) => (
                  <CommandItem
                    key={target}
                    value={target}
                    onSelect={(next) => {
                      setValue(next)
                      setOpen(false)
                    }}
                  >
                    {target}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Button variant="text" onClick={() => setValue(undefined)}>
        Clear
      </Button>
    </Row>
  )
}

export const demos: readonly DemoDefinition[] = [
  { id: 'ui/select/basic', title: 'A labelled select', render: () => <Basic />, visual: true },
  { id: 'ui/select/sizes', title: 'Four sizes', render: () => <Sizes /> },
  {
    id: 'ui/select/states',
    title: 'Nothing chosen, disabled and invalid',
    render: () => <States />,
  },
  {
    id: 'ui/select/grouped',
    title: 'Options grouped by tier (open it to see the groups)',
    render: () => <Grouped />,
    visual: false,
  },
  {
    id: 'ui/select/searchable',
    title: 'A searchable choice: ComboboxTrigger, Popover and Command',
    render: () => <Searchable />,
    visual: false,
  },
]

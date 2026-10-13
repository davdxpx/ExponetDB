import { Copy, Search } from '@exponetdb/icons'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
  Label,
} from '@exponetdb/ui'
import { type ReactNode, useId, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Stack } from './support.tsx'

function Addons(): ReactNode {
  const searchId = useId()
  const slugId = useId()
  const pathId = useId()
  return (
    <Stack className="max-w-sm">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={searchId} className="text-foreground-light">
          Search targets
        </Label>
        <InputGroup>
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput id={searchId} placeholder="Search by path" />
        </InputGroup>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={slugId} className="text-foreground-light">
          Project slug
        </Label>
        <InputGroup>
          <InputGroupAddon>
            <InputGroupText>shop /</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput id={slugId} defaultValue="platform" />
        </InputGroup>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={pathId} className="text-foreground-light">
          Target path
        </Label>
        <InputGroup>
          <InputGroupInput id={pathId} readOnly defaultValue="shop/platform/staging" />
          <InputGroupAddon align="inline-end">
            <InputGroupButton aria-label="Copy target path" icon={<Copy />} />
          </InputGroupAddon>
        </InputGroup>
      </div>
    </Stack>
  )
}

function Block(): ReactNode {
  const id = useId()
  const [value, setValue] = useState('Adds the index the orders report needs.')
  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Label htmlFor={id} className="text-foreground-light">
        Reason
      </Label>
      <InputGroup>
        <InputGroupTextarea
          id={id}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          rows={3}
        />
        <InputGroupAddon align="block-end">
          <InputGroupText>{value.length} of 200</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

function States(): ReactNode {
  const errorId = useId()
  const disabledId = useId()
  return (
    <Stack className="max-w-sm">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${errorId}-field`} className="text-destructive">
          Project slug
        </Label>
        <InputGroup>
          <InputGroupAddon>
            <InputGroupText>shop /</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            id={`${errorId}-field`}
            aria-invalid="true"
            aria-describedby={errorId}
            defaultValue="Platform API"
          />
        </InputGroup>
        <p id={errorId} role="alert" className="text-sm text-destructive">
          Use lowercase letters, digits and hyphens.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={disabledId} className="text-foreground-light">
          Environment
        </Label>
        <InputGroup>
          <InputGroupAddon>
            <InputGroupText>shop / platform /</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput id={disabledId} disabled defaultValue="production" />
        </InputGroup>
      </div>
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/input-group/addons',
    title: 'An icon, a text prefix and a copy button around an input',
    render: () => <Addons />,
  },
  {
    id: 'ui/input-group/block',
    title: 'A block addon under a textarea',
    render: () => <Block />,
  },
  {
    id: 'ui/input-group/states',
    title: 'Invalid and disabled groups',
    render: () => <States />,
  },
]

import { Input, Label, Textarea } from '@exponetdb/ui'
import { type ReactNode, useId } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function Labelled({
  label,
  hint,
  children,
}: {
  readonly label: string
  readonly hint?: string
  readonly children: (ids: { id: string; describedBy: string | undefined }) => ReactNode
}): ReactNode {
  const id = useId()
  const hintId = useId()
  return (
    <div className="flex w-full max-w-sm flex-col gap-1.5">
      <Label htmlFor={id} className="text-foreground-light">
        {label}
      </Label>
      {children({ id, describedBy: hint === undefined ? undefined : hintId })}
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-foreground-lighter">
          {hint}
        </p>
      )}
    </div>
  )
}

function Sizes(): ReactNode {
  return (
    <Stack>
      {(['tiny', 'small', 'medium', 'large'] as const).map((size) => (
        <Labelled key={size} label={`Target path, ${size}`}>
          {({ id }) => <Input id={id} size={size} defaultValue="shop/platform/staging" />}
        </Labelled>
      ))}
    </Stack>
  )
}

function States(): ReactNode {
  const errorId = useId()
  return (
    <Stack>
      <Labelled label="Target path" hint="Product, project and environment, separated by slashes.">
        {({ id, describedBy }) => (
          <Input id={id} placeholder="shop/platform/staging" aria-describedby={describedBy} />
        )}
      </Labelled>
      <Labelled label="Target path, filled">
        {({ id }) => <Input id={id} defaultValue="shop/platform/staging" />}
      </Labelled>
      <Labelled label="Installation ID, read only">
        {({ id }) => <Input id={id} readOnly defaultValue="inst_7K2D9QXM4" className="font-mono" />}
      </Labelled>
      <Labelled label="Environment, disabled">
        {({ id }) => <Input id={id} disabled defaultValue="production" />}
      </Labelled>
      <div className="flex w-full max-w-sm flex-col gap-1.5">
        <Label htmlFor={`${errorId}-input`} className="text-destructive">
          Target slug
        </Label>
        <Input
          id={`${errorId}-input`}
          aria-invalid="true"
          aria-describedby={errorId}
          defaultValue="Platform API"
        />
        <p id={errorId} role="alert" className="text-sm text-destructive">
          Use lowercase letters, digits and hyphens.
        </p>
      </div>
    </Stack>
  )
}

function Types(): ReactNode {
  return (
    <Row className="items-start">
      <Labelled label="Search targets">
        {({ id }) => <Input id={id} type="search" placeholder="Search by path" />}
      </Labelled>
      <Labelled label="Statement timeout, seconds">
        {({ id }) => <Input id={id} type="number" inputMode="numeric" min={1} defaultValue={30} />}
      </Labelled>
    </Row>
  )
}

function Multiline(): ReactNode {
  const errorId = useId()
  return (
    <Stack>
      <Labelled label="Reason" hint="Shown to the person who approves the plan.">
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            defaultValue="Adds the index that the slow orders report needs."
          />
        )}
      </Labelled>
      <div className="flex w-full max-w-sm flex-col gap-1.5">
        <Label htmlFor={`${errorId}-text`} className="text-destructive">
          Reason, required
        </Label>
        <Textarea id={`${errorId}-text`} aria-invalid="true" aria-describedby={errorId} />
        <p id={errorId} role="alert" className="text-sm text-destructive">
          Say why the change is needed. The approver reads this.
        </p>
      </div>
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  { id: 'ui/input/sizes', title: 'Four sizes', render: () => <Sizes /> },
  {
    id: 'ui/input/states',
    title: 'Empty, filled, read only, disabled and invalid',
    render: () => <States />,
  },
  { id: 'ui/input/types', title: 'Search and number inputs', render: () => <Types /> },
  {
    id: 'ui/input/textarea',
    title: 'Textarea, with and without an error',
    render: () => <Multiline />,
  },
]

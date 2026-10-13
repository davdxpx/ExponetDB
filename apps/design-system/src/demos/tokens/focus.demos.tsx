import { Button, Checkbox, Input, Label } from '@exponetdb/ui'
import { type ReactNode, useId } from 'react'
import type { DemoDefinition } from '../types.ts'

/**
 * The two focus treatments drawn without a focus, so a still image can show them. The classes
 * are what `focus-ring` and `focus-inset` paint on `:focus-visible`.
 */
function Specimens(): ReactNode {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs text-foreground-light">focus-ring</p>
        <div className="flex items-center gap-3">
          <span className="rounded-md bg-secondary px-3 py-1.5 text-sm ring-2 ring-ring ring-offset-2 ring-offset-background">
            Create plan
          </span>
          <span className="rounded-md border border-control px-3 py-1.5 text-sm ring-2 ring-ring ring-offset-2 ring-offset-background">
            Cancel
          </span>
        </div>
        <p className="text-sm text-foreground-light">
          A two pixel ring, offset by two pixels. For buttons, inputs and most controls.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs text-foreground-light">focus-inset</p>
        <ul
          aria-label="Rows with the inset treatment"
          className="overflow-hidden rounded-md border border-default text-sm"
        >
          <li className="border-b border-default px-3 py-2">shop/platform/staging</li>
          <li className="border-b border-default px-3 py-2 outline-2 -outline-offset-2 outline-ring">
            shop/platform/production
          </li>
          <li className="px-3 py-2">acme/billing/staging</li>
        </ul>
        <p className="text-sm text-foreground-light">
          An outline drawn inside the box, for rows, tabs and flush surfaces.
        </p>
      </div>
    </div>
  )
}

/** Real controls: press Tab to move through them and see the treatment on each. */
function Keyboard(): ReactNode {
  const pathId = useId()
  const includeId = useId()
  return (
    <div className="flex max-w-md flex-col gap-4">
      <p className="text-sm text-foreground-light">
        Click in the frame, then press Tab and Shift+Tab. A mouse click shows no ring; the keyboard
        does.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={pathId} className="text-foreground-light">
          Target path
        </Label>
        <Input id={pathId} defaultValue="shop/platform/staging" />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id={includeId} />
        <Label htmlFor={includeId}>Include system schemas</Label>
      </div>
      <div className="flex gap-2">
        <Button variant="primary">Create plan</Button>
        <Button variant="default">Cancel</Button>
        <Button variant="link">Open the plan</Button>
      </div>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'tokens/focus/specimens',
    title: 'The two focus treatments, drawn without a focus',
    render: () => <Specimens />,
  },
  {
    id: 'tokens/focus/keyboard',
    title: 'Live controls: tab through them',
    render: () => <Keyboard />,
  },
]

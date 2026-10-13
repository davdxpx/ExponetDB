import {
  Button,
  StatusIcon,
  type StatusVariant,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exponetdb/ui'
import { type ReactNode, useId } from 'react'
import type { DemoDefinition } from '../types.ts'

/**
 * An action that is not available stays focusable, so a keyboard user can reach it and learn why.
 * The reason is also on the button as its description; the tooltip repeats it for the pointer.
 */
function UnavailableAction(): ReactNode {
  const reasonId = useId()
  const reason = 'You created this plan. A different person must approve it.'
  return (
    <div className="flex flex-col items-start gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="primary" disabled focusableWhenDisabled aria-describedby={reasonId}>
            Approve plan
          </Button>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {reason}
      </span>
      <p className="m-0 text-xs text-foreground-lighter">
        Tab to the button. The reason is read with its name and shown in a tooltip.
      </p>
    </div>
  )
}

const SHAPES: readonly { readonly variant: StatusVariant; readonly word: string }[] = [
  { variant: 'info', word: 'Information' },
  { variant: 'success', word: 'Success' },
  { variant: 'warning', word: 'Warning' },
  { variant: 'destructive', word: 'Error' },
]

/** Each status has its own shape and a word, so color is never the only signal. */
function StatusShapes(): ReactNode {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-3 p-0">
      {SHAPES.map((shape) => (
        <li key={shape.variant} className="flex items-center gap-2 text-sm text-foreground">
          <StatusIcon variant={shape.variant} decorative className="size-5" />
          <span>{shape.word}</span>
        </li>
      ))}
    </ul>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/accessibility/unavailable-action',
    title: 'An unavailable action stays focusable and explains itself',
    render: () => <UnavailableAction />,
  },
  {
    id: 'guidance/accessibility/status-shapes',
    title: 'A shape and a word for each status, not only a color',
    render: () => <StatusShapes />,
  },
]

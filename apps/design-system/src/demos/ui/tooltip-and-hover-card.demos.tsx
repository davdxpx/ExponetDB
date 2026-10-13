import { Copy } from '@exponetdb/icons'
import {
  Button,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exponetdb/ui'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function IconTooltip(): ReactNode {
  return (
    <Row>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button aria-label="Copy plan hash" icon={<Copy />} />
        </TooltipTrigger>
        <TooltipContent>Copy plan hash</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="default">Created 12 min ago</Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">2026-10-13 11:48 UTC</TooltipContent>
      </Tooltip>
    </Row>
  )
}

function Reason(): ReactNode {
  const [applied, setApplied] = useState(0)
  return (
    <Stack>
      <Row>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="primary"
              disabled
              focusableWhenDisabled
              onClick={() => setApplied((current) => current + 1)}
            >
              Apply to production
            </Button>
          </TooltipTrigger>
          <TooltipContent>Apply needs an approval from another person.</TooltipContent>
        </Tooltip>
        <p className="text-sm text-foreground-light">Times applied: {applied}</p>
      </Row>
      <p className="text-sm text-foreground-light">
        The button is disabled but focusable, so Tab reaches it and the reason is shown on focus.
      </p>
    </Stack>
  )
}

function Card(): ReactNode {
  return (
    <Row>
      <HoverCard>
        <HoverCardTrigger asChild>
          <Button variant="link">reos-01</Button>
        </HoverCardTrigger>
        <HoverCardContent>
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium text-foreground">Node reos-01</p>
            <p className="text-foreground-light">Agent 0.9.0, heartbeat 12 seconds ago.</p>
            <p className="text-xs text-foreground-lighter">Reported by the agent.</p>
          </div>
        </HoverCardContent>
      </HoverCard>
      <p className="text-sm text-foreground-light">
        Hover or focus the node name. The same facts are on the node page.
      </p>
    </Row>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/tooltip-and-hover-card/tooltip',
    title: 'Tooltips name an icon button and give an exact time',
    render: () => <IconTooltip />,
    visual: false,
  },
  {
    id: 'ui/tooltip-and-hover-card/reason',
    title: 'Why a button is unavailable',
    render: () => <Reason />,
    visual: false,
  },
  {
    id: 'ui/tooltip-and-hover-card/hover-card',
    title: 'A hover card with supplementary detail',
    render: () => <Card />,
    visual: false,
  },
]

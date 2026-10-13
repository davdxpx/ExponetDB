import { Button, toast } from '@exponetdb/ui'
import { codePointLabel, isInvisible } from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { HOSTILE, Row, Stack } from './support.tsx'

/** A toast is text only, so a name that came from outside is made visible before it goes in. */
function visible(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    out += isInvisible(cp) ? codePointLabel(cp) : ch
  }
  return out
}

function Kinds(): ReactNode {
  return (
    <Row>
      <Button variant="default" onClick={() => toast.success('Plan created')}>
        Success
      </Button>
      <Button
        variant="default"
        onClick={() =>
          toast.info('Reading from a cached copy', { description: 'Updated 4 minutes ago.' })
        }
      >
        Info
      </Button>
      <Button
        variant="default"
        onClick={() => toast.warning('The newest backup is not known', { duration: 10_000 })}
      >
        Warning
      </Button>
      <Button
        variant="default"
        onClick={() => toast.error('Could not apply the plan', { code: 'PLAN_STALE' })}
      >
        Error
      </Button>
      <Button variant="text" onClick={() => toast.dismiss()}>
        Dismiss all
      </Button>
    </Row>
  )
}

function WithAction(): ReactNode {
  const [opened, setOpened] = useState(0)
  return (
    <Stack>
      <Row>
        <Button
          variant="default"
          onClick={() =>
            toast.success('Plan created', {
              id: 'plan-created',
              description: 'It expires in 12 minutes.',
              action: {
                label: 'View plan',
                altText: 'Open the plan page to view this plan',
                onClick: () => setOpened((current) => current + 1),
              },
            })
          }
        >
          Create plan
        </Button>
        <p role="status" className="text-sm text-foreground-light">
          The plan page was opened {opened} times.
        </p>
      </Row>
      <p className="text-sm text-foreground-light">
        Press the button again: a toast with the same id replaces the visible one instead of
        stacking a copy. Keep the toast in focus with F8.
      </p>
    </Stack>
  )
}

function Untrusted(): ReactNode {
  return (
    <Row>
      <Button
        variant="default"
        onClick={() =>
          toast.error(`Could not register ${HOSTILE.markup}`, { code: 'INVALID_NAME' })
        }
      >
        Markup in a message
      </Button>
      <Button
        variant="default"
        onClick={() => toast.warning(`Registered ${visible(HOSTILE.bidi)}`, { id: 'visible' })}
      >
        A name with a direction override, made visible
      </Button>
    </Row>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/toast/kinds',
    title: 'The four kinds: errors stay until dismissed',
    render: () => <Kinds />,
    visual: false,
  },
  {
    id: 'ui/toast/action',
    title: 'An action, a stable id, and the notification region',
    render: () => <WithAction />,
    visual: false,
  },
  {
    id: 'ui/toast/untrusted',
    title: 'Text only: markup stays markup, and a name is made visible first',
    render: () => <Untrusted />,
    visual: false,
  },
]

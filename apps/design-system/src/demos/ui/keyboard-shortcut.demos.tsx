import { Button, KeyboardShortcut } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function Variants(): ReactNode {
  return (
    <Stack>
      <Row>
        <span className="text-sm text-foreground-light">Open the command menu</span>
        <KeyboardShortcut keys={['Meta', 'K']} />
      </Row>
      <Row>
        <span className="text-sm text-foreground-light">Go to Changes</span>
        <KeyboardShortcut keys={['G']} />
        <span className="text-xs text-foreground-lighter">then</span>
        <KeyboardShortcut keys={['C']} />
      </Row>
      <Row>
        <span className="text-sm text-foreground-light">Close the panel</span>
        <KeyboardShortcut keys={['Escape']} />
      </Row>
      <Row>
        <span className="text-sm text-foreground-light">Run the statement</span>
        <KeyboardShortcut keys={['Meta', 'Enter']} />
      </Row>
      <p className="text-sm text-foreground-light">
        In running text, press <KeyboardShortcut keys={['Shift', 'ArrowDown']} variant="inline" />{' '}
        to extend the selection.
      </p>
    </Stack>
  )
}

function InButton(): ReactNode {
  return (
    <Row>
      <Button variant="default" iconRight={<KeyboardShortcut keys={['Meta', 'K']} />}>
        Search
      </Button>
    </Row>
  )
}

export const demos: readonly DemoDefinition[] = [
  { id: 'ui/keyboard-shortcut/hints', title: 'Pill and inline hints', render: () => <Variants /> },
  {
    id: 'ui/keyboard-shortcut/in-button',
    title: 'A hint at the end of a button',
    render: () => <InButton />,
  },
]

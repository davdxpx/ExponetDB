import { Button } from '@exponetdb/ui'
import {
  SHORTCUT_DEFINITIONS,
  SHORTCUT_GROUPS,
  type ShortcutId,
  ShortcutKeys,
  ShortcutProvider,
  useOpenShortcutHelp,
  useShortcut,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Outcome } from './support.tsx'

const IDS = Object.keys(SHORTCUT_DEFINITIONS) as ShortcutId[]

/** Every shortcut of the Web App, from the one registry, by group. */
function Reference(): ReactNode {
  return (
    <div className="flex flex-col gap-5">
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group} aria-labelledby={`shortcut-reference-${group}`}>
          <h3
            id={`shortcut-reference-${group}`}
            className="mb-2 text-xs font-medium text-foreground-lighter"
          >
            {group}
          </h3>
          <dl className="m-0 flex flex-col gap-1.5">
            {IDS.filter((id) => SHORTCUT_DEFINITIONS[id].group === group).map((id) => (
              <div key={id} className="flex items-center justify-between gap-4 text-sm">
                <dt className="text-foreground-light">{SHORTCUT_DEFINITIONS[id].label}</dt>
                <dd className="m-0">
                  <ShortcutKeys shortcut={id} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}

/** A page registers a shortcut by id with `useShortcut`; the keys live in the registry only. */
function PageShortcuts({ onRun }: { readonly onRun: (what: string) => void }): ReactNode {
  useShortcut('nav.plans', () => onRun('Go to plans'))
  useShortcut('nav.operations', () => onRun('Go to operations'))
  useShortcut('env.staging', () => onRun('Switch to staging'))
  const openHelp = useOpenShortcutHelp()
  return (
    <Button variant="default" onClick={openHelp}>
      Show keyboard shortcuts
    </Button>
  )
}

function TryShortcuts(): ReactNode {
  const [last, setLast] = useState('')
  return (
    // `apple` pins the modifier so the demo reads the same on every platform.
    <ShortcutProvider apple={false}>
      <p className="mt-0 mb-3 text-sm text-foreground-light">
        Press <ShortcutKeys shortcut="nav.plans" />, <ShortcutKeys shortcut="nav.operations" /> or{' '}
        <ShortcutKeys shortcut="env.staging" />, or open the list with the button. The letter
        shortcuts can be switched off in that list.
      </p>
      <PageShortcuts onRun={setLast} />
      <Outcome>{last === '' ? '' : `Shortcut ran: ${last}.`}</Outcome>
    </ShortcutProvider>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/keyboard-shortcuts/reference',
    title: 'All shortcuts, from the registry',
    render: () => <Reference />,
  },
  {
    id: 'guidance/keyboard-shortcuts/try-it',
    title: 'Try the sequences and open the list with the button',
    render: () => <TryShortcuts />,
  },
]

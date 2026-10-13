import { Button, Label, Switch } from '@exponetdb/ui'
import {
  CommandMenu,
  CommandMenuTriggerInput,
  CommandProvider,
  type ICommand,
  NavigateProvider,
  SHORTCUT_DEFINITIONS,
  SHORTCUT_GROUPS,
  ShortcutKeys,
  ShortcutProvider,
  useOpenShortcutHelp,
  useRegisterCommands,
  useShortcut,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'

const SHORTCUT_IDS = Object.keys(SHORTCUT_DEFINITIONS) as (keyof typeof SHORTCUT_DEFINITIONS)[]

function Commands({
  canApprove,
  onLog,
}: {
  canApprove: boolean
  onLog: (text: string) => void
}): null {
  const commands: ICommand[] = [
    { id: 'go-plans', name: 'Go to plans', href: '/changes/plans', shortcut: 'nav.plans' },
    { id: 'go-targets', name: 'Go to targets', href: '/targets', shortcut: 'nav.targets' },
    { id: 'go-audit', name: 'Go to audit', href: '/audit', shortcut: 'nav.audit' },
    {
      id: 'copy-hash',
      name: 'Copy plan hash',
      keywords: ['sha256', 'checksum'],
      action: () => onLog('Copied the plan hash.'),
      closeOnSelect: true,
    },
    {
      id: 'approve-plan',
      name: 'Approve plan',
      action: () => onLog('Opened the approval for this plan.'),
      closeOnSelect: true,
      // The app computes this from the person's permissions; the menu only hides what is off.
      enabled: canApprove,
    },
  ]
  useRegisterCommands('Commands', commands, { deps: [canApprove] })
  return null
}

function HelpButton(): ReactNode {
  const open = useOpenShortcutHelp()
  return (
    <Button type="button" variant="outline" onClick={open}>
      Show keyboard shortcuts
    </Button>
  )
}

function ShortcutHandlers({ onLog }: { onLog: (text: string) => void }): null {
  useShortcut('env.staging', () => onLog('The app would switch to staging.'))
  return null
}

/**
 * One provider for the whole demo: the shortcuts listen on the document, so two
 * demos with a provider on one page would both react to the same keys.
 */
function MenuDemo(): ReactNode {
  const [log, setLog] = useState('Open the menu, search, and run a command.')
  const [canApprove, setCanApprove] = useState(true)
  return (
    <NavigateProvider navigate={(path) => setLog(`The app would go to ${path}.`)}>
      <ShortcutProvider apple={false}>
        <CommandProvider>
          <Commands canApprove={canApprove} onLog={setLog} />
          <ShortcutHandlers onLog={setLog} />
          <div className="flex max-w-md flex-col gap-3">
            <CommandMenuTriggerInput />
            <CommandMenu />
            <div className="flex items-center gap-2">
              <Switch
                id="command-demo-approve"
                checked={canApprove}
                onCheckedChange={setCanApprove}
              />
              <Label htmlFor="command-demo-approve">This person may approve plans</Label>
            </div>
            <div>
              <HelpButton />
            </div>
            <p role="status" className="text-sm text-foreground-light">
              {log}
            </p>
          </div>
        </CommandProvider>
      </ShortcutProvider>
    </NavigateProvider>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/command-menu/menu',
    title:
      'Command menu: Control+K opens it, G then P goes to plans, a switch shows a permission turning a command off',
    visual: false,
    render: () => <MenuDemo />,
  },
  {
    id: 'ui-patterns/shortcuts/all',
    title:
      'Every shortcut of the Web App, by group, as the keys and as the words a screen reader hears',
    render: () => (
      <div className="flex flex-col gap-5">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group} aria-labelledby={`shortcut-demo-${group}`}>
            <h3
              id={`shortcut-demo-${group}`}
              className="mb-2 text-xs font-medium text-foreground-lighter"
            >
              {group}
            </h3>
            <dl className="m-0 flex flex-col gap-1.5">
              {SHORTCUT_IDS.filter((id) => SHORTCUT_DEFINITIONS[id].group === group).map((id) => (
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
    ),
  },
]

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ReactNode, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CommandMenu,
  CommandMenuTrigger,
  CommandMenuTriggerInput,
} from '../../../src/command-menu/api/command-menu.tsx'
import { CommandProvider } from '../../../src/command-menu/api/command-provider.tsx'
import { useRegisterCommands } from '../../../src/command-menu/api/hooks/commands-hooks.ts'
import {
  useRegisterCommandPage,
  useSetCommandPage,
} from '../../../src/command-menu/api/hooks/pages-hooks.ts'
import {
  useCommandMenuOpen,
  useSetCommandMenuOpen,
} from '../../../src/command-menu/api/hooks/view-hooks.ts'
import { CommandPageType } from '../../../src/command-menu/api/utils.ts'
import type { ICommand } from '../../../src/command-menu/internal/types.ts'
import {
  NavigateProvider,
  type TelemetryEvent,
  TelemetryProvider,
} from '../../../src/seams/index.ts'
import { ShortcutProvider } from '../../../src/shortcuts/index.ts'
import { axeViolations } from '../../support/axe.ts'

afterEach(cleanup)

const baseCommands = (): ICommand[] => [
  { id: 'nav-plans', name: 'Go to plans', href: '/changes/plans', shortcut: 'nav.plans' },
  { id: 'nav-targets', name: 'Go to targets', href: '/targets', shortcut: 'nav.targets' },
  {
    id: 'copy-hash',
    name: 'Copy plan hash',
    keywords: ['sha256', 'checksum'],
    action: () => {},
  },
]

function Registrar({
  section = 'Navigation',
  commands,
}: {
  section?: string
  commands: ICommand[]
}): ReactNode {
  useRegisterCommands(section, commands, { deps: [] })
  return null
}

interface HarnessProps {
  commands?: ICommand[]
  navigate?: (path: string) => void
  events?: TelemetryEvent[]
  children?: ReactNode
  menu?: ReactNode
}

function Harness({
  commands = baseCommands(),
  navigate = () => {},
  events = [],
  children,
  menu = <CommandMenu />,
}: HarnessProps): ReactNode {
  return (
    <NavigateProvider navigate={navigate}>
      <TelemetryProvider onTelemetry={(event) => events.push(event)}>
        <ShortcutProvider apple={false} strict>
          <CommandProvider>
            <Registrar commands={commands} />
            <CommandMenuTriggerInput />
            {menu}
            {children}
          </CommandProvider>
        </ShortcutProvider>
      </TelemetryProvider>
    </NavigateProvider>
  )
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /search commands/i }))
  return screen.findByRole('dialog', { name: 'Command menu' })
}

describe('CommandMenu', () => {
  it('opens from its trigger as a named dialog with a search field and grouped commands', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const trigger = screen.getByRole('button', { name: /search commands/i })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).toBeNull()

    const dialog = await openMenu(user)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    const search = within(dialog).getByRole('combobox', { name: 'Search commands' })
    expect(search).toHaveFocus()
    expect(within(dialog).getByRole('listbox', { name: 'Commands' })).toBeInTheDocument()
    expect(within(dialog).getByRole('group')).toBeInTheDocument()
    expect(within(dialog).getAllByRole('option')).toHaveLength(3)
  })

  it('has no accessibility violations while closed, and names its shortcut', async () => {
    render(<Harness />)

    const trigger = screen.getByRole('button', { name: /search commands/i })
    expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Control+K')
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('shows no shortcut hint and claims no shortcut when shortcuts are not set up', () => {
    render(
      <CommandProvider>
        <CommandMenuTriggerInput />
      </CommandProvider>,
    )

    const trigger = screen.getByRole('button', { name: 'Search commands' })
    expect(trigger).not.toHaveAttribute('aria-keyshortcuts')
  })

  it('has no accessibility violations when open', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await openMenu(user)

    expect(await axeViolations(document.body)).toEqual([])
  })

  it('filters while typing, also by keywords, and highlights the match as text', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await openMenu(user)

    await user.type(within(dialog).getByRole('combobox'), 'checksum')
    expect(within(dialog).getAllByRole('option')).toHaveLength(1)
    expect(within(dialog).getByRole('option', { name: /copy plan hash/i })).toBeInTheDocument()

    await user.clear(within(dialog).getByRole('combobox'))
    await user.type(within(dialog).getByRole('combobox'), 'plans')
    const option = within(dialog).getByRole('option', { name: /go to plans/i })
    expect(option.querySelector('.font-semibold')?.textContent).toBe('plans')
  })

  it('says so when nothing matches, and how many match otherwise', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await openMenu(user)
    const search = within(dialog).getByRole('combobox')

    await user.type(search, 'go to')
    expect(within(dialog).getByRole('status')).toHaveTextContent('2 commands match your search.')

    await user.clear(search)
    await user.type(search, 'zzzz')
    expect(within(dialog).queryAllByRole('option')).toHaveLength(0)
    expect(within(dialog).getByRole('status')).toHaveTextContent('No commands match your search.')
  })

  it('says that no commands are available when none is registered', async () => {
    const user = userEvent.setup()
    render(<Harness commands={[]} />)
    const dialog = await openMenu(user)

    expect(within(dialog).getByRole('status')).toHaveTextContent('No commands are available here.')
  })

  it('renders names and keywords as text, never as markup', async () => {
    const user = userEvent.setup()
    const hostile = '<img src=x onerror="document.title=1"><b>bold</b>'
    render(<Harness commands={[{ id: 'x', name: hostile, action: () => {} }]} />)
    const dialog = await openMenu(user)

    expect(within(dialog).getByRole('option')).toHaveTextContent(hostile)
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog.querySelector('b')).toBeNull()
  })

  it('navigates through the seam, closes, and reports the kind but never the typed text', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    const events: TelemetryEvent[] = []
    render(<Harness navigate={navigate} events={events} />)
    const dialog = await openMenu(user)

    await user.type(within(dialog).getByRole('combobox'), 'targets')
    await user.keyboard('{Enter}')

    expect(navigate).toHaveBeenCalledExactlyOnceWith('/targets')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(events).toEqual([
      { name: 'command_menu.opened', properties: { trigger: 'button' } },
      { name: 'command_menu.command_run', properties: { kind: 'href', via: 'menu' } },
      { name: 'command_menu.closed' },
    ])
    expect(JSON.stringify(events)).not.toContain('targets')
  })

  it('refuses a path that is not an app path', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    const commands: ICommand[] = [
      { id: 'evil', name: 'Evil link', href: '//evil.example/plans' as `/${string}` },
    ]
    render(<Harness navigate={navigate} commands={commands} />)
    const dialog = await openMenu(user)

    await user.click(within(dialog).getByRole('option', { name: /evil link/i }))

    expect(navigate).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('runs an action and keeps the menu open unless the command asks to close it', async () => {
    const user = userEvent.setup()
    const stay = vi.fn()
    const leave = vi.fn()
    const commands: ICommand[] = [
      { id: 'stay', name: 'Run and stay', action: stay },
      { id: 'leave', name: 'Run and close', action: leave, closeOnSelect: true },
    ]
    render(<Harness commands={commands} />)
    const dialog = await openMenu(user)

    await user.click(within(dialog).getByRole('option', { name: /run and stay/i }))
    expect(stay).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('option', { name: /run and close/i }))
    expect(leave).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('leaves out a command the caller disabled and lists the permitted ones', async () => {
    const user = userEvent.setup()
    const commands: ICommand[] = [
      { id: 'approve', name: 'Approve plan', action: () => {}, enabled: false },
      { id: 'view', name: 'View plan', action: () => {}, enabled: true },
      { id: 'hidden', name: 'Hidden until searched', action: () => {}, defaultHidden: true },
    ]
    render(<Harness commands={commands} />)
    const dialog = await openMenu(user)

    expect(
      within(dialog)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['View plan'])

    await user.type(within(dialog).getByRole('combobox'), 'hidden')
    expect(within(dialog).getByRole('option', { name: /hidden until searched/i })).toBeVisible()
    await user.clear(within(dialog).getByRole('combobox'))
    await user.type(within(dialog).getByRole('combobox'), 'approve')
    expect(within(dialog).queryByRole('option', { name: /approve plan/i })).toBeNull()
  })

  it('shows the shortcut of a command next to its name, as words for a screen reader', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await openMenu(user)

    const option = within(dialog).getByRole('option', { name: /go to plans/i })
    expect(option).toHaveTextContent('G then P')
    expect(within(option).getByText('G then P')).toHaveClass('sr-only')
  })

  describe('keyboard', () => {
    it('toggles with Control+K', async () => {
      const user = userEvent.setup()
      const events: TelemetryEvent[] = []
      render(<Harness events={events} />)

      await user.keyboard('{Control>}k{/Control}')
      expect(await screen.findByRole('dialog', { name: 'Command menu' })).toBeInTheDocument()
      expect(events[0]).toEqual({
        name: 'command_menu.opened',
        properties: { trigger: 'shortcut' },
      })

      await user.keyboard('{Control>}k{/Control}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it('does not open while another dialog is open', async () => {
      const user = userEvent.setup()
      render(
        <Harness>
          <div role="dialog" aria-label="Confirm" data-state="open" />
        </Harness>,
      )

      await user.keyboard('{Control>}k{/Control}')
      expect(screen.queryByRole('dialog', { name: 'Command menu' })).toBeNull()
    })

    it('runs a command by the shortcut it carries, while the menu is closed', async () => {
      const user = userEvent.setup()
      const navigate = vi.fn()
      const events: TelemetryEvent[] = []
      render(<Harness navigate={navigate} events={events} />)

      await user.keyboard('gp')

      expect(navigate).toHaveBeenCalledExactlyOnceWith('/changes/plans')
      expect(events).toEqual([
        { name: 'command_menu.command_run', properties: { kind: 'href', via: 'shortcut' } },
      ])
    })

    it('does not run a disabled command by its shortcut', async () => {
      const user = userEvent.setup()
      const navigate = vi.fn()
      const commands: ICommand[] = [
        {
          id: 'nav-plans',
          name: 'Go to plans',
          href: '/changes/plans',
          shortcut: 'nav.plans',
          enabled: false,
        },
      ]
      render(<Harness navigate={navigate} commands={commands} />)

      await user.keyboard('gp')

      expect(navigate).not.toHaveBeenCalled()
    })

    it('leaves the search text alone: shortcuts do not fire while typing in the search field', async () => {
      const user = userEvent.setup()
      const navigate = vi.fn()
      render(<Harness navigate={navigate} />)
      const dialog = await openMenu(user)

      await user.type(within(dialog).getByRole('combobox'), 'gp')

      expect(navigate).not.toHaveBeenCalled()
      expect(within(dialog).getByRole('combobox')).toHaveValue('gp')
    })

    it('uses Escape to clear the search, then leave a page, then close', async () => {
      const user = userEvent.setup()

      function Pages(): ReactNode {
        useRegisterCommandPage('Switch environment', {
          type: CommandPageType.Commands,
          sections: [
            {
              id: 'environments',
              name: 'Environments',
              commands: [{ id: 'production', name: 'Production', action: () => {} }],
            },
          ],
        })
        const setPage = useSetCommandPage()
        useRegisterCommands(
          'Environment',
          [
            {
              id: 'switch',
              name: 'Switch environment',
              action: () => setPage('Switch environment'),
            },
          ],
          { deps: [] },
        )
        return null
      }

      render(
        <Harness commands={[]}>
          <Pages />
        </Harness>,
      )
      const dialog = await openMenu(user)
      const search = within(dialog).getByRole('combobox')

      await user.click(within(dialog).getByRole('option', { name: /switch environment/i }))
      expect(await within(dialog).findByRole('option', { name: 'Production' })).toBeInTheDocument()
      expect(
        within(dialog).getByRole('button', { name: 'Back from Switch environment' }),
      ).toBeInTheDocument()

      await user.type(within(dialog).getByRole('combobox'), 'prod')
      await user.keyboard('{Escape}')
      expect(within(dialog).getByRole('combobox')).toHaveValue('')
      expect(within(dialog).getByRole('option', { name: 'Production' })).toBeInTheDocument()

      await user.keyboard('{Escape}')
      expect(
        await within(dialog).findByRole('option', { name: /switch environment/i }),
      ).toBeInTheDocument()
      expect(within(dialog).queryByRole('button', { name: /back from/i })).toBeNull()
      expect(search).toBeInTheDocument()

      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })
  })

  it('starts at the top level with an empty search each time it opens', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    let dialog = await openMenu(user)

    await user.type(within(dialog).getByRole('combobox'), 'targets')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    dialog = await openMenu(user)
    expect(within(dialog).getByRole('combobox')).toHaveValue('')
    expect(within(dialog).getAllByRole('option')).toHaveLength(3)
  })

  it('closes when the browser goes back', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await openMenu(user)

    window.dispatchEvent(new PopStateEvent('popstate'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows a component page in place of the list', async () => {
    const user = userEvent.setup()

    function Pages(): ReactNode {
      useRegisterCommandPage('Details', {
        type: CommandPageType.Component,
        component: () => <p>Details page body</p>,
      })
      const setPage = useSetCommandPage()
      useRegisterCommands(
        'Pages',
        [{ id: 'details', name: 'Open details', action: () => setPage('Details') }],
        { deps: [] },
      )
      return null
    }

    render(
      <Harness commands={[]}>
        <Pages />
      </Harness>,
    )
    const dialog = await openMenu(user)
    await user.click(within(dialog).getByRole('option', { name: /open details/i }))

    expect(await within(dialog).findByText('Details page body')).toBeInTheDocument()
    expect(within(dialog).queryByRole('combobox')).toBeNull()
  })

  it('shows a fallback instead of the error when a page fails, and recovers on request', async () => {
    const user = userEvent.setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onError = vi.fn()
    let broken = true

    function Fragile(): ReactNode {
      if (broken) throw new Error('secret internal detail')
      return <p>Recovered body</p>
    }

    render(
      <Harness menu={<CommandMenu onError={onError}>{<Fragile />}</CommandMenu>} commands={[]} />,
    )
    const dialog = await openMenu(user)

    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('The command menu could not be shown.')
    expect(alert).not.toHaveTextContent('secret internal detail')
    expect(onError).toHaveBeenCalledOnce()

    broken = false
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }))
    expect(await within(dialog).findByText('Recovered body')).toBeInTheDocument()
    consoleError.mockRestore()
  })

  it('can be opened and closed from code', async () => {
    const user = userEvent.setup()

    function Controls(): ReactNode {
      const open = useCommandMenuOpen()
      const setOpen = useSetCommandMenuOpen()
      const [label] = useState('Open the menu from code')
      return (
        <button type="button" onClick={() => setOpen(!open)}>
          {label}
        </button>
      )
    }

    render(
      <Harness>
        <Controls />
      </Harness>,
    )
    await user.click(screen.getByRole('button', { name: 'Open the menu from code' }))
    expect(await screen.findByRole('dialog', { name: 'Command menu' })).toBeInTheDocument()
  })

  it('applies the search only when an IME composition ends', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await openMenu(user)
    const search = within(dialog).getByRole('combobox')

    fireEvent.compositionStart(search)
    fireEvent.change(search, { target: { value: 'plan' } })
    expect(search).toHaveValue('plan')
    expect(dialog.querySelector('.font-semibold')).toBeNull()

    fireEvent.compositionEnd(search)
    expect(dialog.querySelector('.font-semibold')?.textContent).toBe('plan')
  })

  it('does not move focus into the search field on a narrow screen', async () => {
    const user = userEvent.setup()
    const narrow = vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }))
    try {
      render(<Harness />)
      const dialog = await openMenu(user)

      expect(within(dialog).getByRole('combobox')).not.toHaveFocus()
    } finally {
      narrow.mockRestore()
    }
  })

  it('wraps any button as a trigger that opens the menu and still calls its own click handler', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Harness>
        <CommandMenuTrigger>
          <button type="button" onClick={onClick}>
            Open palette
          </button>
        </CommandMenuTrigger>
      </Harness>,
    )

    const button = screen.getByRole('button', { name: 'Open palette' })
    expect(button).toHaveAttribute('aria-controls', 'command-menu-dialog-content')
    await user.click(button)

    expect(await screen.findByRole('dialog', { name: 'Command menu' })).toBeInTheDocument()
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(onClick).toHaveBeenCalledOnce()
  })
})

// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/api/hooks/commandsHooks.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Fragment, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandProvider } from '../../../../src/command-menu/api/command-provider.tsx'
import {
  useCommands,
  useRegisterCommands,
} from '../../../../src/command-menu/api/hooks/commands-hooks.ts'
import type { ICommand } from '../../../../src/command-menu/api/types.ts'

afterEach(cleanup)

const oneCommand: ICommand[] = [
  {
    id: 'command-one',
    name: 'Command one',
    action: () => {},
  },
]

const twoCommands: ICommand[] = [
  ...oneCommand,
  {
    id: 'command-two',
    name: 'Command two',
    action: () => {},
  },
]

let mockCommandMenuRenderCount = 0

const MockCommandMenu = () => {
  mockCommandMenuRenderCount++
  const commandSections = useCommands()

  return (
    <div>
      {commandSections.map((section) => (
        <Fragment key={section.id}>
          <h2>{section.name}</h2>
          <ul>
            {section.commands.map((cmd) => (
              <li key={cmd.id}>{cmd.name}</li>
            ))}
          </ul>
        </Fragment>
      ))}
    </div>
  )
}

const SimpleComponent = ({ commands }: { commands: ICommand[] }) => {
  useRegisterCommands('Section', commands)

  return <span>Simple</span>
}

const ToggledComponent = ({ commands }: { commands: ICommand[] }) => {
  const [visible, setVisible] = useState(true)

  return (
    <>
      <button type="button" onClick={() => setVisible((vis) => !vis)}>
        Toggle
      </button>
      {visible && <SimpleComponent commands={commands} />}
    </>
  )
}

const DisableableComponent = ({ commands }: { commands: ICommand[] }) => {
  const [enabled, setIsEnabled] = useState(true)
  useRegisterCommands('Section', commands, { enabled })

  return (
    <button type="button" onClick={() => setIsEnabled((enabled) => !enabled)}>
      {enabled ? 'Disable commands' : 'Enable commands'}
    </button>
  )
}

const ChangeableCommands = () => {
  const [commands, setCommands] = useState<ICommand[]>(twoCommands.slice(0, 1))
  useRegisterCommands('Section', commands, { deps: [commands] })

  return (
    <button type="button" onClick={() => setCommands(twoCommands.slice(1, 2))}>
      Use second command
    </button>
  )
}

const RerenderableComponent = () => {
  const [renderFlag, setRerenderFlag] = useState(0)

  // Define commands inline so the array identity changes each render
  const commands = [...oneCommand]
  useRegisterCommands('Section', commands) // Note no dependency array

  return (
    <>
      <button type="button" onClick={() => setRerenderFlag((flag) => flag + 1)}>
        Rerender
      </button>
      <span>Render flag: {renderFlag}</span>
    </>
  )
}

describe('useRegisterCommand', () => {
  beforeEach(() => {
    mockCommandMenuRenderCount = 0
  })

  it('registers a command when component mounts', () => {
    render(
      <CommandProvider>
        <SimpleComponent commands={oneCommand} />
        <MockCommandMenu />
      </CommandProvider>,
    )

    expect(screen.getByRole('heading')).toHaveTextContent('Section')
    expect(screen.getByRole('listitem')).toHaveTextContent('Command one')
  })

  it('registers multiple commands when component mounts', () => {
    render(
      <CommandProvider>
        <SimpleComponent commands={twoCommands} />
        <MockCommandMenu />
      </CommandProvider>,
    )

    expect(screen.getByRole('heading')).toHaveTextContent('Section')

    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Command one')
    expect(items[1]).toHaveTextContent('Command two')
  })

  it('unregisters and reregisters a command when component unmounts and remounts', async () => {
    const user = userEvent.setup()
    render(
      <CommandProvider>
        <ToggledComponent commands={oneCommand} />
        <MockCommandMenu />
      </CommandProvider>,
    )

    expect(screen.getByRole('listitem')).toHaveTextContent('Command one')

    await user.click(screen.getByRole('button'))
    await waitFor(() => {
      expect(screen.queryByRole('listitem')).toBeNull()
    })

    await user.click(screen.getByRole('button'))
    await waitFor(() => {
      expect(screen.getByRole('listitem')).toHaveTextContent('Command one')
    })
  })

  it('unregisters multiple commands when component unmounts', async () => {
    const user = userEvent.setup()
    render(
      <CommandProvider>
        <ToggledComponent commands={twoCommands} />
        <MockCommandMenu />
      </CommandProvider>,
    )

    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    await user.click(screen.getByRole('button'))
    await waitFor(() => {
      expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    })
  })

  it('unregisters and reregisters a command when enabled changes', async () => {
    const user = userEvent.setup()
    render(
      <CommandProvider>
        <DisableableComponent commands={oneCommand} />
        <MockCommandMenu />
      </CommandProvider>,
    )

    expect(screen.getByRole('listitem')).toHaveTextContent('Command one')

    await user.click(screen.getByRole('button'))
    await waitFor(() => {
      expect(screen.queryByRole('listitem')).toBeNull()
    })

    await user.click(screen.getByRole('button'))
    await waitFor(() => {
      expect(screen.getByRole('listitem')).toHaveTextContent('Command one')
    })
  })

  it('reregisters commands when dependencies change', async () => {
    const user = userEvent.setup()
    render(
      <CommandProvider>
        <ChangeableCommands />
        <MockCommandMenu />
      </CommandProvider>,
    )

    expect(screen.getByText('Command one')).toBeVisible()

    await user.click(screen.getByRole('button'))
    await waitFor(() => {
      expect(screen.queryByText('Command one')).toBeNull()
    })
    expect(screen.getByRole('listitem')).toHaveTextContent('Command two')
  })

  it("doesn't trigger command menu rerender when dependencies are unchanged", async () => {
    const user = userEvent.setup()
    expect(mockCommandMenuRenderCount).toBe(0)

    render(
      <CommandProvider>
        <RerenderableComponent />
        <MockCommandMenu />
      </CommandProvider>,
    )

    // React renders twice in dev mode
    expect(mockCommandMenuRenderCount).toBe(2)

    await user.click(screen.getByRole('button'))
    await waitFor(() => screen.getByText('Render flag: 1'))

    expect(mockCommandMenuRenderCount).toBe(2)
  })

  it('hides a command the caller disabled and a section left without commands', () => {
    const permitted: ICommand = { id: 'permitted', name: 'Open plans', action: () => {} }
    const forbidden: ICommand = {
      id: 'forbidden',
      name: 'Open approvals',
      action: () => {},
      enabled: false,
    }
    const onlyForbidden: ICommand = {
      id: 'secret',
      name: 'Open audit',
      href: '/audit',
      enabled: false,
    }

    const Registrar = () => {
      useRegisterCommands('Changes', [permitted, forbidden])
      useRegisterCommands('Access', [onlyForbidden])
      return null
    }

    render(
      <CommandProvider>
        <Registrar />
        <MockCommandMenu />
      </CommandProvider>,
    )

    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Changes',
    ])
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Open plans'])
  })

  it('shows a command as soon as the caller enables it', async () => {
    const user = userEvent.setup()
    const Gate = () => {
      const [allowed, setAllowed] = useState(false)
      useRegisterCommands(
        'Changes',
        [{ id: 'approve', name: 'Approve plan', action: () => {}, enabled: allowed }],
        {
          deps: [allowed],
        },
      )
      return (
        <button type="button" onClick={() => setAllowed(true)}>
          Grant
        </button>
      )
    }

    render(
      <CommandProvider>
        <Gate />
        <MockCommandMenu />
      </CommandProvider>,
    )
    expect(screen.queryByRole('listitem')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Grant' }))
    expect(screen.getByRole('listitem')).toHaveTextContent('Approve plan')
  })

  it('keeps the commands of the first render while the dependencies stay the same', async () => {
    const user = userEvent.setup()
    const Counter = () => {
      const [count, setCount] = useState(0)
      useRegisterCommands('Section', [{ id: 'count', name: `Count ${count}`, action: () => {} }])
      return (
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          Add
        </button>
      )
    }

    render(
      <CommandProvider>
        <Counter />
        <MockCommandMenu />
      </CommandProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByRole('listitem')).toHaveTextContent('Count 0')
  })
})

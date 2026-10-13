// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/api/hooks/pagesHooks.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { CommandProvider } from '../../../../src/command-menu/api/command-provider.tsx'
import {
  useCurrentCommandPage,
  usePopCommandPage,
  useRegisterCommandPage,
  useSetCommandPage,
} from '../../../../src/command-menu/api/hooks/pages-hooks.ts'
import {
  useCommandMenuQuery,
  useSetCommandMenuQuery,
} from '../../../../src/command-menu/api/hooks/query-hooks.ts'
import { CommandPageType } from '../../../../src/command-menu/api/utils.ts'

afterEach(cleanup)

const PageAdderOne = ({ enabled = true }) => {
  useRegisterCommandPage('Page one', { type: CommandPageType.Commands, sections: [] }, { enabled })
  const setPage = useSetCommandPage()

  useEffect(() => {
    if (enabled) {
      setPage('Page one')
    }
  }, [enabled, setPage])

  return <div>Page Adder One</div>
}

const TogglePageAdder = () => {
  const [mounted, setIsMounted] = useState(true)

  return (
    <>
      <button type="button" onClick={() => setIsMounted((mounted) => !mounted)}>
        {mounted ? 'Dismount' : 'Mount'}
      </button>
      {mounted && <PageAdderOne />}
    </>
  )
}

const TogglePageEnabled = () => {
  const [enabled, setIsEnabled] = useState(true)

  return (
    <>
      <button type="button" onClick={() => setIsEnabled((enabled) => !enabled)}>
        {enabled ? 'Disable' : 'Enable'}
      </button>
      <PageAdderOne enabled={enabled} />
    </>
  )
}

const PageDisplay = () => {
  const currentPage = useCurrentCommandPage()

  return <div data-testid="current-page">{currentPage?.name ?? '[None]'}</div>
}

describe('useRegisterCommandPage', () => {
  it('registers a page on mount', async () => {
    render(
      <CommandProvider>
        <PageAdderOne />
        <PageDisplay />
      </CommandProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-page')).toHaveTextContent('Page one')
    })
  })

  it("doesn't register a page on mount if disabled", async () => {
    render(
      <CommandProvider>
        <PageAdderOne enabled={false} />
        <PageDisplay />
      </CommandProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-page')).toHaveTextContent('[None]')
    })
  })

  it('unregisters a page on dismount', async () => {
    const user = userEvent.setup()
    render(
      <CommandProvider>
        <TogglePageAdder />
        <PageDisplay />
      </CommandProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-page')).toHaveTextContent('Page one')
    })

    await user.click(screen.getByRole('button'))
    await waitFor(() => {
      expect(screen.getByTestId('current-page')).toHaveTextContent('[None]')
    })
  })

  it('unregisters and reregisters a page if disabled toggled', async () => {
    const user = userEvent.setup()
    render(
      <CommandProvider>
        <TogglePageEnabled />
        <PageDisplay />
      </CommandProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-page')).toHaveTextContent('Page one')
    })

    await user.click(screen.getByRole('button'))
    await waitFor(() => {
      expect(screen.getByTestId('current-page')).toHaveTextContent('[None]')
    })

    await user.click(screen.getByRole('button'))
    await waitFor(() => {
      expect(screen.getByTestId('current-page')).toHaveTextContent('Page one')
    })
  })

  it('opens a registered page and goes back from it', async () => {
    const user = userEvent.setup()
    const Controls = () => {
      useRegisterCommandPage('Switch environment', { type: CommandPageType.Commands, sections: [] })
      const setPage = useSetCommandPage()
      const popPage = usePopCommandPage()
      return (
        <>
          <button type="button" onClick={() => setPage('Switch environment')}>
            Open page
          </button>
          <button type="button" onClick={popPage}>
            Go back
          </button>
        </>
      )
    }

    render(
      <CommandProvider>
        <Controls />
        <PageDisplay />
      </CommandProvider>,
    )
    expect(screen.getByTestId('current-page')).toHaveTextContent('[None]')

    await user.click(screen.getByRole('button', { name: 'Open page' }))
    expect(screen.getByTestId('current-page')).toHaveTextContent('Switch environment')

    await user.click(screen.getByRole('button', { name: 'Go back' }))
    expect(screen.getByTestId('current-page')).toHaveTextContent('[None]')
  })

  it('clears the search text when a page opens, unless asked to keep it', async () => {
    const user = userEvent.setup()
    const Probe = () => {
      useRegisterCommandPage('Page', { type: CommandPageType.Commands, sections: [] })
      const setPage = useSetCommandPage()
      const setQuery = useSetCommandMenuQuery()
      const query = useCommandMenuQuery()
      return (
        <>
          <output data-testid="query">{query}</output>
          <button type="button" onClick={() => setQuery('plans')}>
            Type
          </button>
          <button type="button" onClick={() => setPage('Page')}>
            Open
          </button>
          <button type="button" onClick={() => setPage('Page', true)}>
            Open and keep
          </button>
        </>
      )
    }

    render(
      <CommandProvider>
        <Probe />
      </CommandProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Type' }))
    await user.click(screen.getByRole('button', { name: 'Open and keep' }))
    expect(screen.getByTestId('query')).toHaveTextContent('plans')

    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByTestId('query')).toBeEmptyDOMElement()
  })
})

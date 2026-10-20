import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { crashActions, diagnosticText } from '../../src/app/error-page.tsx'
import { settingsKeys } from '../../src/features/settings/keys.ts'
import { FakeServer, meOf, mountApp } from '../account/support.tsx'

/**
 * The crash page (a route that fails to render): the router's own fallback
 * prints the exception's message, which can hold data, so the page never reads
 * the error. A page of the app is replaced by it and the shell around stays.
 */
const boom = vi.hoisted(() => ({
  /** `now`: the overview throws on its first draw; `later`: when `trigger` runs; `never`. */
  mode: 'now' as 'now' | 'later' | 'never',
  shell: false,
  trigger: undefined as (() => void) | undefined,
  secret: 'row 7: ssn 078-05-1120 <img src=x onerror=alert(1)>',
}))

vi.mock('../../src/features/fleet/fleet-page.tsx', async () => {
  const { createElement, useState } = await import('react')
  return {
    FleetPage: () => {
      const [later, setLater] = useState(false)
      boom.trigger = () => setLater(true)
      if (boom.mode === 'now' || (boom.mode === 'later' && later)) throw new Error(boom.secret)
      return createElement('h1', null, 'Overview page')
    },
  }
})

vi.mock('../../src/shell/commands.tsx', () => ({
  ShellCommands: () => {
    if (boom.shell) throw new Error(boom.secret)
    return null
  },
}))

beforeEach(() => {
  boom.mode = 'now'
  boom.shell = false
  boom.trigger = undefined
  // React and the router log a caught render error; the page under test is what it shows.
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function signedIn(): FakeServer {
  return new FakeServer().signedIn(meOf())
}

const TITLE = 'This page failed to render'

describe('the crash page', () => {
  it('replaces the page that failed, keeps the shell around it and shows nothing of the error', async () => {
    mountApp('/', signedIn())
    const heading = await screen.findByRole('heading', { level: 2, name: TITLE })
    expect(heading).toBeInTheDocument()
    // The navigation of the shell is still there, and the page is in its `main` landmark.
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('main')).getByRole('region', { name: TITLE }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('main')).toHaveLength(1)
    // The exception's text (a row, a name) and the router's own fallback never reach the page.
    expect(document.body.textContent).not.toContain('078-05-1120')
    expect(document.body.textContent).not.toContain('onerror')
    expect(document.body.textContent).not.toContain('Something went wrong!')
    expect(document.body.innerHTML).not.toContain('<img src=x')
    // Focus moves to the explanation, so it is the first thing a keyboard or screen reader user meets.
    expect(document.activeElement).toBe(screen.getByRole('region', { name: TITLE }))
  })

  it('offers "Try again" and "Reload" and details to copy, with no stack', async () => {
    mountApp('/', signedIn())
    await screen.findByRole('heading', { level: 2, name: TITLE })
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument()
    const details = screen.getByRole('textbox', { name: 'Diagnostic details' })
    expect(details).toHaveAttribute('readonly')
    expect((details as HTMLTextAreaElement).value).not.toMatch(/\bat\s+\S+\s+\(/)
  })

  it('lists the route id, the time and "not read" for the version, and requests nothing while it is shown', async () => {
    const server = signedIn()
    mountApp('/', server)
    await screen.findByRole('heading', { level: 2, name: TITLE })
    const text = (
      screen.getByRole('textbox', { name: 'Diagnostic details' }) as HTMLTextAreaElement
    ).value
    const lines = text.split('\n')
    expect(lines[0]).toBe('Route: /_app/')
    expect(lines[1]).toBe('App version: not read')
    expect(lines[2]).toMatch(/^Time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(lines).toHaveLength(3)
    // Never fetched on error: the installation is not requested, and nothing else is.
    expect(server.requests.map((request) => request.path)).not.toContain('/api/v1/installation')
    expect(server.requests.every((request) => request.method === 'GET')).toBe(true)
  })

  it('holds the app version when an earlier read of the installation is already cached', async () => {
    boom.mode = 'later'
    const server = signedIn()
    const { queryClient } = mountApp('/', server)
    await screen.findByRole('heading', { name: 'Overview page' })
    queryClient.setQueryData(settingsKeys.installation, { version: '1.4.2', features: [] })
    const before = server.requests.length
    act(() => boom.trigger?.())
    await screen.findByRole('heading', { level: 2, name: TITLE })
    const text = (
      screen.getByRole('textbox', { name: 'Diagnostic details' }) as HTMLTextAreaElement
    ).value
    expect(text.split('\n')[1]).toBe('App version: 1.4.2')
    expect(server.requests.slice(before).map((request) => request.path)).not.toContain(
      '/api/v1/installation',
    )
  })

  it('draws the page again with "Try again" when the failure is gone', async () => {
    const user = userEvent.setup()
    mountApp('/', signedIn())
    await screen.findByRole('heading', { level: 2, name: TITLE })
    boom.mode = 'never'
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Overview page' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: TITLE })).not.toBeInTheDocument()
  })

  it('stays on the crash page when "Try again" fails again', async () => {
    const user = userEvent.setup()
    mountApp('/', signedIn())
    await screen.findByRole('heading', { level: 2, name: TITLE })
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { level: 2, name: TITLE })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('078-05-1120')
  })

  it('reloads the page with "Reload"', async () => {
    const reload = vi.spyOn(crashActions, 'reload').mockImplementation(() => undefined)
    const user = userEvent.setup()
    mountApp('/', signedIn())
    await screen.findByRole('heading', { level: 2, name: TITLE })
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('copies the details and says so, or says it could not', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_text: string) => undefined)
    vi.stubGlobal('navigator', { ...window.navigator, clipboard: { writeText } })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    mountApp('/', signedIn())
    await screen.findByRole('heading', { level: 2, name: TITLE })
    const text = (
      screen.getByRole('textbox', { name: 'Diagnostic details' }) as HTMLTextAreaElement
    ).value
    await user.click(screen.getByRole('button', { name: 'Copy details' }))
    expect(await screen.findByText('Copied.')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(text)

    writeText.mockRejectedValueOnce(new Error('denied'))
    await user.click(screen.getByRole('button', { name: 'Copy details' }))
    expect(await screen.findByText(/Could not copy/)).toBeInTheDocument()
    expect(screen.queryByText('Copied.')).not.toBeInTheDocument()
  })

  it('is the main landmark itself when the shell is what failed', async () => {
    boom.mode = 'never'
    boom.shell = true
    mountApp('/', signedIn())
    const heading = await screen.findByRole('heading', { level: 2, name: TITLE })
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument()
    expect(screen.getByRole('main')).toContainElement(heading)
    const details = screen.getByRole('textbox', {
      name: 'Diagnostic details',
    }) as HTMLTextAreaElement
    expect(details.value.split('\n')[0]).toBe('Route: /_app')
    expect(document.body.textContent).not.toContain('078-05-1120')
  })

  it('has no accessibility violations', async () => {
    mountApp('/', signedIn())
    await screen.findByRole('heading', { level: 2, name: TITLE })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument())
    expect(await axeViolations()).toEqual([])
  })
})

describe('the diagnostic text', () => {
  it('is three lines of facts that are not data', () => {
    const time = new Date('2026-10-20T08:30:00.000Z')
    expect(
      diagnosticText({
        route: '/_app/t/$product/$project/$environment/sql',
        version: '2.0.1',
        time,
      }),
    ).toBe(
      [
        'Route: /_app/t/$product/$project/$environment/sql',
        'App version: 2.0.1',
        'Time: 2026-10-20T08:30:00.000Z',
      ].join('\n'),
    )
    expect(diagnosticText({ route: '/_app/', version: undefined, time }).split('\n')[1]).toBe(
      'App version: not read',
    )
  })
})

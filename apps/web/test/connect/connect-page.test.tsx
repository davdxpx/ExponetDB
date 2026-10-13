import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { mountApp, OAuthWorld } from '../consent/support.tsx'

afterEach(cleanup)
afterEach(() => vi.restoreAllMocks())

const URL = `${window.location.origin}/mcp`

async function openConnect(path = '/connect') {
  const world = new OAuthWorld()
  const mounted = mountApp(path, world)
  await screen.findByRole('heading', { level: 1, name: 'Connect an MCP client' })
  return { world, ...mounted }
}

function selectedTab(): string | null {
  return screen.getByRole('tab', { selected: true }).textContent
}

describe('the MCP connect page', () => {
  it('shows the server URL of this origin and the five clients as text', async () => {
    const { world } = await openConnect()
    expect(screen.getAllByText(URL).length).toBeGreaterThan(0)
    const tabs = within(screen.getByRole('tablist', { name: 'Client' }))
      .getAllByRole('tab')
      .map((tab) => tab.textContent)
    expect(tabs).toEqual(['Claude Code', 'Claude', 'Cursor', 'Codex', 'VS Code'])
    expect(document.querySelector('img')).toBeNull()
    expect(selectedTab()).toBe('Claude Code')
    expect(screen.getByText(`claude mcp add --transport http exponetdb ${URL}`)).toBeInTheDocument()
    // The page reads no data: only the session of the shell.
    expect(world.paths()).toEqual(['/api/v1/me'])
  })

  it('opens the client the address names', async () => {
    await openConnect('/connect?client=codex')
    expect(selectedTab()).toBe('Codex')
    expect(screen.getByText(/oauth_resource = /)).toBeInTheDocument()
  })

  it('falls back to the first client for an id it does not know, and echoes nothing', async () => {
    const { router } = await openConnect('/connect?client=%3Cscript%3Ealert(1)%3C%2Fscript%3E')
    expect(selectedTab()).toBe('Claude Code')
    expect(document.body.textContent).not.toContain('script')
    // The unknown value does not stay in the address either.
    await waitFor(() => expect(router.state.location.href).toBe('/connect'))
  })

  it('keeps the chosen client in the address', async () => {
    const { router } = await openConnect()
    // The page sits beside the Access section menu. jsdom gives every element an empty box at
    // the origin, so the menu's resize handle claims every pointerdown (and suppresses the
    // mousedown that selects a tab); the tab is selected by its mousedown directly.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Cursor' }), { button: 0 })
    await waitFor(() => expect(router.state.location.search).toEqual({ client: 'cursor' }))
    expect(selectedTab()).toBe('Cursor')
    expect(screen.getByText('agent mcp login exponetdb')).toBeInTheDocument()
  })

  it('copies a snippet to the clipboard and says so', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await openConnect()
    await user.click(screen.getByRole('button', { name: 'Copy MCP server URL' }))
    expect(writeText).toHaveBeenCalledWith(URL)
    expect(await screen.findByText('MCP server URL copied')).toBeInTheDocument()
  })

  it('says when the clipboard refused the text', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await openConnect()
    await act(async () => {
      await user.click(screen.getAllByRole('button', { name: 'Copy Command' })[0] as HTMLElement)
    })
    expect(await screen.findByText('Could not copy to the clipboard')).toBeInTheDocument()
  })

  it('lists the scopes to ask for and what an agent can never do', async () => {
    await openConnect()
    expect(screen.getByRole('heading', { name: 'Scopes to ask for' })).toBeInTheDocument()
    expect(
      screen.getByText('targets.read schema.read diagnostics.read migrations.read'),
    ).toBeInTheDocument()
    expect(screen.getByText('What the agent can never do')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    await openConnect('/connect?client=vscode')
    expect(await axeViolations()).toEqual([])
  })
})

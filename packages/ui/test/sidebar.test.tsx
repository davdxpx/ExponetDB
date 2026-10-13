import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isSidebarShortcutAllowed,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '../src/sidebar.tsx'
import { axeViolations } from './support/axe.ts'

const originalWidth = window.innerWidth

afterEach(() => {
  // unmount first: the provider listens on window, and a leftover one would answer the next test
  cleanup()
  window.innerWidth = originalWidth
  vi.restoreAllMocks()
})

function State() {
  const { state, open } = useSidebar()
  return (
    <p data-testid="state">
      {state}:{String(open)}
    </p>
  )
}

function Layout({
  sidebarProps,
  providerProps,
}: {
  sidebarProps?: Partial<React.ComponentProps<typeof Sidebar>>
  providerProps?: Partial<React.ComponentProps<typeof SidebarProvider>>
}) {
  return (
    <SidebarProvider {...providerProps}>
      <Sidebar collapsible="icon" {...sidebarProps}>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive tooltip="Targets">
                  <span>Targets</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton>
                  <span>Migrations</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <SidebarTrigger />
        <State />
      </SidebarInset>
    </SidebarProvider>
  )
}

describe('SidebarProvider and persistence', () => {
  it('is open by default and toggles from the trigger', async () => {
    const user = userEvent.setup()
    render(<Layout />)

    expect(screen.getByTestId('state')).toHaveTextContent('expanded:true')
    await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    expect(screen.getByTestId('state')).toHaveTextContent('collapsed:false')
  })

  it('reports each toggle through onOpenChange, so the app can save the choice', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<Layout providerProps={{ onOpenChange }} />)

    await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    // an uncontrolled sidebar still changes, whether or not the app listens
    expect(screen.getByTestId('state')).toHaveTextContent('collapsed:false')

    await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
  })

  it('follows the open prop when controlled and only asks for the change', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<Layout providerProps={{ open: true, onOpenChange }} />)

    await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.getByTestId('state')).toHaveTextContent('expanded:true')
  })

  it('starts collapsed with defaultOpen={false}', () => {
    render(<Layout providerProps={{ defaultOpen: false }} />)

    expect(screen.getByTestId('state')).toHaveTextContent('collapsed:false')
  })

  it('writes no cookie and no storage', async () => {
    const user = userEvent.setup()
    const cookie = vi.spyOn(document, 'cookie', 'set')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    render(<Layout />)

    await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))

    expect(cookie).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(document.cookie).toBe('')
  })
})

describe('Sidebar behaviors', () => {
  it('always open: stays expanded and keeps its width in the layout', () => {
    const { container } = render(<Layout providerProps={{ open: true }} />)

    const sidebar = container.querySelector('[data-collapsible][data-state]')
    expect(sidebar).toHaveAttribute('data-state', 'expanded')
    expect(sidebar).toHaveAttribute('data-collapsible', '')
    expect(sidebar).not.toHaveClass('w-12')
  })

  it('collapsed: shows the icon width and names each entry through its text', () => {
    const { container } = render(<Layout providerProps={{ open: false }} />)

    const sidebar = container.querySelector('[data-collapsible][data-state]')
    expect(sidebar).toHaveAttribute('data-state', 'collapsed')
    expect(sidebar).toHaveAttribute('data-collapsible', 'icon')
    expect(screen.getByRole('button', { name: 'Migrations' })).toBeInTheDocument()
  })

  it('expand on hover: opens over the page while the pointer is on it and closes when it leaves', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const { container } = render(
      <Layout
        providerProps={{ open: false, onOpenChange }}
        sidebarProps={{ expandOnHover: true }}
      />,
    )

    const sidebar = container.querySelector('[data-collapsible][data-state]')
    expect(sidebar).toHaveAttribute('data-state', 'collapsed')
    // the layout reserves the icon width only: the page does not move
    expect(sidebar).toHaveClass('w-12')

    await user.hover(screen.getByRole('button', { name: 'Targets' }))
    expect(sidebar).toHaveAttribute('data-state', 'expanded')
    expect(screen.getByTestId('state')).toHaveTextContent('expanded:false')

    await user.unhover(screen.getByRole('button', { name: 'Targets' }))
    expect(sidebar).toHaveAttribute('data-state', 'collapsed')
    // hovering is not a choice: nothing to save
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('expand on hover: also opens when focus moves into it and closes when focus leaves', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <Layout providerProps={{ open: false }} sidebarProps={{ expandOnHover: true }} />,
    )

    const sidebar = container.querySelector('[data-collapsible][data-state]')
    const targets = screen.getByRole('button', { name: 'Targets' })

    act(() => targets.focus())
    expect(sidebar).toHaveAttribute('data-state', 'expanded')

    await user.tab()
    expect(screen.getByRole('button', { name: 'Migrations' })).toHaveFocus()
    expect(sidebar).toHaveAttribute('data-state', 'expanded')

    act(() => screen.getByRole('button', { name: 'Toggle sidebar' }).focus())
    expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  })

  it('expand on hover: stays open while either the pointer or focus is inside', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <Layout providerProps={{ open: false }} sidebarProps={{ expandOnHover: true }} />,
    )

    const sidebar = container.querySelector('[data-collapsible][data-state]')
    const targets = screen.getByRole('button', { name: 'Targets' })
    act(() => targets.focus())
    await user.hover(targets)
    await user.unhover(targets)
    expect(sidebar).toHaveAttribute('data-state', 'expanded')

    act(() => targets.blur())
    expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  })

  it('expand on hover: ignores a touch, which cannot leave', () => {
    const { container } = render(
      <Layout providerProps={{ open: false }} sidebarProps={{ expandOnHover: true }} />,
    )

    const inner = screen
      .getByRole('button', { name: 'Targets' })
      .closest('[data-sidebar="sidebar"]')?.parentElement as HTMLElement
    fireEvent.pointerEnter(inner, { pointerType: 'touch' })
    expect(container.querySelector('[data-collapsible][data-state]')).toHaveAttribute(
      'data-state',
      'collapsed',
    )
    fireEvent.pointerEnter(inner, { pointerType: 'mouse' })
    expect(container.querySelector('[data-collapsible][data-state]')).toHaveAttribute(
      'data-state',
      'expanded',
    )
  })

  it('has no accessibility violations in either state', async () => {
    const { rerender } = render(<Layout providerProps={{ open: true }} />)
    expect(await axeViolations()).toEqual([])

    rerender(<Layout providerProps={{ open: false }} />)
    expect(await axeViolations()).toEqual([])
  })
})

describe('Sidebar toggle controls', () => {
  it('tells assistive technology whether the sidebar is open', async () => {
    const user = userEvent.setup()
    render(<Layout />)

    const trigger = screen.getByRole('button', { name: 'Toggle sidebar' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('offers the rail as a pointer shortcut that is not an extra tab stop', async () => {
    const user = userEvent.setup()
    const { container } = render(<Layout />)

    const rail = container.querySelector<HTMLElement>('[data-sidebar="rail"]')
    expect(rail).toHaveAttribute('tabindex', '-1')
    expect(rail).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getAllByRole('button', { name: 'Toggle sidebar' })).toHaveLength(1)
    await user.click(rail as HTMLElement)
    expect(screen.getByTestId('state')).toHaveTextContent('collapsed:false')
  })
})

describe('Sidebar shortcut', () => {
  it('has none unless the app asks for one', () => {
    render(<Layout />)

    fireEvent.keyDown(window, { code: 'KeyB', ctrlKey: true })
    fireEvent.keyDown(window, { code: 'Backslash', ctrlKey: true })
    expect(screen.getByTestId('state')).toHaveTextContent('expanded:true')
  })

  it('toggles on the configured combination only', () => {
    render(<Layout providerProps={{ shortcut: { code: 'Backslash', ctrl: true } }} />)

    fireEvent.keyDown(window, { code: 'Backslash' })
    fireEvent.keyDown(window, { code: 'Backslash', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(window, { code: 'KeyB', ctrlKey: true })
    expect(screen.getByTestId('state')).toHaveTextContent('expanded:true')

    fireEvent.keyDown(window, { code: 'Backslash', ctrlKey: true })
    expect(screen.getByTestId('state')).toHaveTextContent('collapsed:false')
    fireEvent.keyDown(window, { code: 'Backslash', ctrlKey: true })
    expect(screen.getByTestId('state')).toHaveTextContent('expanded:true')
  })

  it('ignores a repeat, a composition and a key someone else handled', () => {
    render(<Layout providerProps={{ shortcut: { code: 'Backslash', ctrl: true } }} />)

    fireEvent.keyDown(window, { code: 'Backslash', ctrlKey: true, repeat: true })
    fireEvent.keyDown(window, { code: 'Backslash', ctrlKey: true, isComposing: true })
    const handled = new KeyboardEvent('keydown', {
      code: 'Backslash',
      ctrlKey: true,
      cancelable: true,
    })
    handled.preventDefault()
    window.dispatchEvent(handled)

    expect(screen.getByTestId('state')).toHaveTextContent('expanded:true')
  })

  it('takes the key from the page only when it fires', () => {
    render(<Layout providerProps={{ shortcut: { code: 'Backslash', ctrl: true } }} />)

    const other = new KeyboardEvent('keydown', { code: 'KeyA', ctrlKey: true, cancelable: true })
    window.dispatchEvent(other)
    expect(other.defaultPrevented).toBe(false)

    const mine = new KeyboardEvent('keydown', {
      code: 'Backslash',
      ctrlKey: true,
      cancelable: true,
    })
    window.dispatchEvent(mine)
    expect(mine.defaultPrevented).toBe(true)
  })

  it('refuses combinations that browsers and text fields use', () => {
    render(<Layout providerProps={{ shortcut: { code: 'KeyB', ctrl: true } }} />)

    fireEvent.keyDown(window, { code: 'KeyB', ctrlKey: true })
    expect(screen.getByTestId('state')).toHaveTextContent('expanded:true')
  })

  it('allows only the combinations that browsers leave alone', () => {
    // Ctrl or Cmd with a letter or digit: new tab, find, bold, bookmarks sidebar, tab switching
    for (const code of ['KeyB', 'KeyT', 'KeyW', 'KeyN', 'KeyF', 'Digit1', 'BracketLeft', 'Comma']) {
      expect(isSidebarShortcutAllowed({ code, ctrl: true })).toBe(false)
      expect(isSidebarShortcutAllowed({ code, meta: true })).toBe(false)
      expect(isSidebarShortcutAllowed({ code, ctrl: true, shift: true })).toBe(false)
    }
    // no modifier at all would fire while typing
    expect(isSidebarShortcutAllowed({ code: 'Backslash' })).toBe(false)
    expect(isSidebarShortcutAllowed({ code: 'KeyB', shift: true })).toBe(false)
    // Alt with a letter, digit or arrow: menus, tab switching, back and forward
    for (const code of ['KeyD', 'KeyF', 'Digit1', 'ArrowLeft', 'ArrowRight', 'Home']) {
      expect(isSidebarShortcutAllowed({ code, alt: true })).toBe(false)
    }
    expect(isSidebarShortcutAllowed({ code: 'Backslash', ctrl: true })).toBe(true)
    expect(isSidebarShortcutAllowed({ code: 'Slash', meta: true, shift: true })).toBe(true)
    expect(isSidebarShortcutAllowed({ code: 'BracketLeft', alt: true })).toBe(true)
  })

  it('stops listening when the provider goes away', () => {
    const { unmount } = render(
      <Layout providerProps={{ shortcut: { code: 'Backslash', ctrl: true } }} />,
    )
    unmount()

    const event = new KeyboardEvent('keydown', {
      code: 'Backslash',
      ctrlKey: true,
      cancelable: true,
    })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('SidebarMenuButton', () => {
  it('marks the current entry with aria-current and the active styling', () => {
    render(<Layout />)

    const targets = screen.getByRole('button', { name: 'Targets' })
    expect(targets).toHaveAttribute('aria-current', 'page')
    expect(targets).toHaveAttribute('data-active', 'true')
    expect(screen.getByRole('button', { name: 'Migrations' })).not.toHaveAttribute('aria-current')
  })

  it('takes a natively disabled entry out of the tab order', async () => {
    const user = userEvent.setup()
    render(
      <SidebarProvider>
        <SidebarMenuButton disabled>Backups</SidebarMenuButton>
        <SidebarMenuButton>Nodes</SidebarMenuButton>
      </SidebarProvider>,
    )

    expect(screen.getByRole('button', { name: 'Backups' })).toBeDisabled()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Nodes' })).toHaveFocus()
  })

  it('keeps an entry focusable when disabled with a reason, and suppresses its click', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <SidebarProvider>
        <SidebarMenuButton
          disabled
          focusableWhenDisabled
          onClick={onClick}
          tooltip="Backups need a node agent"
        >
          Backups
        </SidebarMenuButton>
      </SidebarProvider>,
    )

    const button = screen.getByRole('button', { name: 'Backups' })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('tabindex', '0')

    await user.tab()
    expect(button).toHaveFocus()
    await user.click(button)
    await user.keyboard('{Enter}')
    expect(onClick).not.toHaveBeenCalled()
    expect(await axeViolations()).toEqual([])
  })

  it('does not suppress the click of an enabled entry', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <SidebarProvider>
        <SidebarMenuButton onClick={onClick}>Nodes</SidebarMenuButton>
      </SidebarProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Nodes' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders as the link it is given (asChild) and keeps a disabled link from navigating', async () => {
    const user = userEvent.setup()
    const navigated = vi.fn((event: Event) => event.preventDefault())
    document.addEventListener('click', navigated)
    render(
      <SidebarProvider>
        <SidebarMenuButton asChild isActive>
          <a href="/targets">Targets</a>
        </SidebarMenuButton>
        <SidebarMenuButton asChild disabled>
          <a href="/backups">Backups</a>
        </SidebarMenuButton>
      </SidebarProvider>,
    )

    expect(screen.getByRole('link', { name: 'Targets' })).toHaveAttribute('aria-current', 'page')
    const disabled = screen.getByRole('link', { name: 'Backups' })
    expect(disabled).toHaveAttribute('aria-disabled', 'true')
    expect(disabled).not.toHaveAttribute('disabled')
    await user.click(disabled)
    // the click was stopped before it could bubble to the document
    expect(navigated).not.toHaveBeenCalled()
    document.removeEventListener('click', navigated)
  })

  it('shows its tooltip only while the sidebar is collapsed', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Layout providerProps={{ open: false }} />)

    await user.hover(screen.getByRole('button', { name: 'Targets' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Targets')
    unmount()

    render(<Layout providerProps={{ open: true }} />)
    await user.hover(screen.getByRole('button', { name: 'Targets' }))
    // the label is visible, so the tooltip would only repeat it
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows the reason of a disabled entry whatever the state of the sidebar', async () => {
    const user = userEvent.setup()
    render(
      <SidebarProvider open>
        <SidebarMenuButton disabled focusableWhenDisabled tooltip="Backups need a node agent">
          Backups
        </SidebarMenuButton>
      </SidebarProvider>,
    )

    await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Backups need a node agent')
    expect(screen.getByRole('button', { name: 'Backups' })).toHaveAccessibleDescription(
      'Backups need a node agent',
    )
  })

  it('leaves the Escape key to the sheet while its tooltip is closed', async () => {
    window.innerWidth = 500
    const user = userEvent.setup()
    render(<Layout />)

    await user.click(await screen.findByRole('button', { name: 'Toggle sidebar' }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('SidebarMenuSkeleton', () => {
  it('has a width that stays the same between renders', () => {
    const { container, rerender } = render(<SidebarMenuSkeleton />)
    const width = () =>
      container
        .querySelector<HTMLElement>('[data-sidebar="menu-skeleton-text"]')
        ?.style.getPropertyValue('--skeleton-width')

    const first = width()
    expect(first).toMatch(/^[5-8][0-9]%$/)
    rerender(<SidebarMenuSkeleton />)
    expect(width()).toBe(first)
  })
})

describe('Sidebar on small screens', () => {
  it('is a named dialog sheet that opens from the trigger and closes with Escape', async () => {
    window.innerWidth = 500
    const user = userEvent.setup()
    render(<Layout />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const trigger = await screen.findByRole('button', { name: 'Toggle sidebar' })
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Navigation' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Migrations' })).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('uses the label it is given for the sheet', async () => {
    window.innerWidth = 500
    const user = userEvent.setup()
    render(<Layout sidebarProps={{ label: 'Project navigation' }} />)

    await user.click(await screen.findByRole('button', { name: 'Toggle sidebar' }))
    expect(await screen.findByRole('dialog', { name: 'Project navigation' })).toBeInTheDocument()
  })
})

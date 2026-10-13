import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  useResizableLayout,
} from '../src/resizable.tsx'
import { axeViolations } from './support/axe.ts'

// jsdom has no layout: give the group a size so that keyboard resizing has a width to divide.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(500)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const width = this.hasAttribute('data-separator') ? 1 : 1000
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 500,
      width,
      height: 500,
      toJSON: () => ({}),
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function Panels({ withHandle = false, label }: { withHandle?: boolean; label?: string }) {
  return (
    <ResizablePanelGroup orientation="horizontal" id="main">
      <ResizablePanel id="nav" defaultSize={30} minSize={10}>
        Navigation
      </ResizablePanel>
      <ResizableHandle withHandle={withHandle} {...(label ? { 'aria-label': label } : {})} />
      <ResizablePanel id="content" defaultSize={70}>
        Content
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

describe('Resizable', () => {
  it('renders the panels and a separator', () => {
    const { container } = render(<Panels />)

    expect(screen.getByText('Navigation')).toBeInTheDocument()
    expect(screen.getByText('Content')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="resizable-panel-group"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-slot="resizable-panel"]')).toHaveLength(2)
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('labels the handle, with a default and with the label the caller gives', () => {
    const { rerender } = render(<Panels />)
    expect(screen.getByRole('separator', { name: 'Resize panels' })).toBeInTheDocument()

    rerender(<Panels label="Resize navigation" />)
    expect(screen.getByRole('separator', { name: 'Resize navigation' })).toBeInTheDocument()
  })

  it('makes the handle a tab stop that exposes its orientation and value', async () => {
    const user = userEvent.setup()
    render(<Panels />)

    const handle = screen.getByRole('separator')
    expect(handle).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle).toHaveAttribute('tabindex', '0')
    expect(handle).toHaveAttribute('aria-valuenow')

    await user.tab()
    expect(handle).toHaveFocus()
    expect(handle).toHaveClass('focus-ring')
  })

  it('has no accessibility violations, with or without the grip', async () => {
    const { rerender } = render(<Panels />)
    expect(await axeViolations()).toEqual([])

    rerender(<Panels withHandle />)
    expect(await axeViolations()).toEqual([])
  })

  it('hides the decorative grip from assistive technology', () => {
    const { container } = render(<Panels withHandle />)

    const grip = container.querySelector('[role="separator"] > div')
    expect(grip).toHaveAttribute('aria-hidden', 'true')
  })

  it('resizes with the keyboard and reports the layout once the key is released', async () => {
    const user = userEvent.setup()
    const onLayoutChanged = vi.fn()
    render(
      <ResizablePanelGroup orientation="horizontal" id="keys" onLayoutChanged={onLayoutChanged}>
        <ResizablePanel id="nav" defaultSize={30} minSize={10}>
          Navigation
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="content" defaultSize={70}>
          Content
        </ResizablePanel>
      </ResizablePanelGroup>,
    )

    const handle = screen.getByRole('separator')
    const before = handle.getAttribute('aria-valuenow')
    await user.tab()
    await user.keyboard('{ArrowRight}')

    expect(onLayoutChanged).toHaveBeenCalled()
    expect(handle.getAttribute('aria-valuenow')).not.toBe(before)
  })

  it('starts from the layout the app gives it', () => {
    render(
      <ResizablePanelGroup
        orientation="horizontal"
        id="saved"
        defaultLayout={{ nav: 25, content: 75 }}
      >
        <ResizablePanel id="nav">Navigation</ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="content">Content</ResizablePanel>
      </ResizablePanelGroup>,
    )

    expect(Number(screen.getByRole('separator').getAttribute('aria-valuenow'))).toBe(25)
  })
})

describe('useResizableLayout', () => {
  function Saved({ storage }: { storage: Pick<Storage, 'getItem' | 'setItem'> }) {
    const { defaultLayout, onLayoutChanged } = useResizableLayout({ id: 'layout', storage })
    return (
      <ResizablePanelGroup
        orientation="horizontal"
        id="layout"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel id="nav" defaultSize={30} minSize={10}>
          Navigation
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="content" defaultSize={70}>
          Content
        </ResizablePanel>
      </ResizablePanelGroup>
    )
  }

  it('reads and writes only the storage it is given, never the browser local storage', async () => {
    const user = userEvent.setup()
    const local = vi.spyOn(Storage.prototype, 'setItem')
    const memory = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => memory.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        memory.set(key, value)
      }),
    }
    render(<Saved storage={storage} />)

    expect(storage.getItem).toHaveBeenCalled()
    await user.tab()
    await user.keyboard('{ArrowRight}')

    expect(storage.setItem).toHaveBeenCalled()
    expect(local).not.toHaveBeenCalled()
  })
})

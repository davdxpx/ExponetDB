// Derived from supabase/supabase packages/ui/src/components/KeyboardShortcut/KeyboardShortcut.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { KeyboardShortcut } from '../src/keyboard-shortcut.tsx'
import { axeViolations } from './support/axe.ts'

const originalNavigator = global.navigator

const setNavigator = (platform: string, userAgent: string) => {
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: {
      ...originalNavigator,
      platform,
      userAgent,
    },
  })
}

describe('KeyboardShortcut', () => {
  afterEach(() => {
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: originalNavigator,
    })
  })

  it('renders arrow keys as symbols', () => {
    render(<KeyboardShortcut keys={['ArrowUp']} />)

    expect(screen.getByText('↑')).toBeInTheDocument()
  })

  it('renders compact mac-style shortcuts for symbol and single-character keys', () => {
    setNavigator('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)')

    render(<KeyboardShortcut keys={['Meta', 'ArrowUp']} />)

    expect(screen.getByText('⌘↑')).toBeInTheDocument()
  })

  it('keeps word-style non-mac shortcuts readable', () => {
    setNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')

    render(<KeyboardShortcut keys={['Meta', 'ArrowUp']} />)

    expect(screen.getByText('Ctrl ↑')).toBeInTheDocument()
  })

  it('renders the pill and the inline variant without accessibility violations', async () => {
    render(
      <>
        <KeyboardShortcut keys={['Shift', 'Enter']} />
        <KeyboardShortcut keys={['K']} variant="inline" />
      </>,
    )

    const pill = screen.getByText(/Enter|↵/)
    expect(pill.className).toContain('border-border-muted')
    expect(screen.getByText('K').className).toContain('items-baseline')
    expect(await axeViolations()).toEqual([])
  })

  it('merges a className and upper-cases single letters', () => {
    render(<KeyboardShortcut keys={['g', 'd']} className="ml-2" />)

    const shortcut = screen.getByText('GD')
    expect(shortcut).toHaveClass('ml-2')
  })
})

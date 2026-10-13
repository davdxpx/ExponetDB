import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { CSP_CASES } from '../src/csp-surface/cases.tsx'
import { navigate } from '../src/router.tsx'

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

describe('design-system app', () => {
  it('renders its heading', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ExponetDB design system')
  })

  it('lists every CSP case once, by a unique id', () => {
    render(<App />)
    act(() => navigate('/csp-surface'))
    const ids = [...document.querySelectorAll('[data-csp-case]')].map((a) =>
      a.getAttribute('data-csp-case'),
    )
    expect(ids).toEqual(CSP_CASES.map((c) => c.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('renders a page-not-found state for an unknown path', () => {
    render(<App />)
    act(() => navigate('/nowhere'))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Page not found')
  })

  it('never navigates to another origin', () => {
    render(<App />)
    act(() => navigate('//evil.example/x'))
    expect(window.location.pathname).toBe('/')
  })
})

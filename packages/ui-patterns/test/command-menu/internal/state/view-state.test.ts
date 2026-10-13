import { describe, expect, it, vi } from 'vitest'

import { initViewState } from '../../../../src/command-menu/internal/state/view-state.ts'

describe('viewState', () => {
  it('starts closed, not initiated and large', () => {
    expect(initViewState().getState()).toEqual({ initiated: false, open: false, size: 'large' })
  })

  it('opens, closes and toggles, and remembers that the menu was used', () => {
    const viewState = initViewState()

    viewState.setOpen(true)
    expect(viewState.getState()).toMatchObject({ initiated: true, open: true })

    viewState.toggleOpen()
    expect(viewState.getState().open).toBe(false)

    viewState.toggleOpen()
    expect(viewState.getState().open).toBe(true)

    viewState.setOpen(false)
    expect(viewState.getState()).toMatchObject({ initiated: true, open: false })
  })

  it('sets the size and tells subscribers', () => {
    const viewState = initViewState()
    const listener = vi.fn()
    viewState.subscribe(listener)

    viewState.setSize('xlarge')

    expect(viewState.getState().size).toBe('xlarge')
    expect(listener).toHaveBeenCalledOnce()
  })
})

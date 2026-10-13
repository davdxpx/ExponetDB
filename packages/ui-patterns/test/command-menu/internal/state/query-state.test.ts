import { describe, expect, it, vi } from 'vitest'

import { initQueryState } from '../../../../src/command-menu/internal/state/query-state.ts'

describe('queryState', () => {
  it('starts empty and holds what is set', () => {
    const queryState = initQueryState()
    expect(queryState.getState()).toBe('')

    queryState.setQuery('plans')
    expect(queryState.getState()).toBe('plans')
  })

  it('tells subscribers only when the text changes', () => {
    const queryState = initQueryState()
    const listener = vi.fn()
    queryState.subscribe(listener)

    queryState.setQuery('plans')
    queryState.setQuery('plans')

    expect(listener).toHaveBeenCalledOnce()
  })
})

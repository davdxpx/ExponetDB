import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createStore, useStoreValue } from '../../../../src/command-menu/internal/state/store.ts'

afterEach(cleanup)

describe('createStore', () => {
  it('holds the state and replaces it with a value or with a function of the old state', () => {
    const store = createStore({ count: 1 })
    expect(store.getState()).toEqual({ count: 1 })

    store.setState({ count: 2 })
    expect(store.getState()).toEqual({ count: 2 })

    store.setState((previous) => ({ count: previous.count + 5 }))
    expect(store.getState()).toEqual({ count: 7 })
  })

  it('does not notify when the state is the same object', () => {
    const state = { count: 1 }
    const store = createStore(state)
    const listener = vi.fn()
    store.subscribe(listener)

    store.setState(state)
    store.setState((previous) => previous)

    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies each subscriber once per change until it unsubscribes', () => {
    const store = createStore(0)
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = store.subscribe(first)
    store.subscribe(second)

    store.setState(1)
    stopFirst()
    store.setState(2)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('lets a listener unsubscribe while it is being notified', () => {
    const store = createStore(0)
    const later = vi.fn()
    const stop = store.subscribe(() => stop())
    store.subscribe(later)

    expect(() => store.setState(1)).not.toThrow()
    expect(later).toHaveBeenCalledOnce()
  })
})

describe('useStoreValue', () => {
  function Reader({ store }: { store: ReturnType<typeof createStore<{ a: number; b: number }>> }) {
    const a = useStoreValue(store, (state) => state.a)
    return <output data-testid="a">{a}</output>
  }

  it('shows the selected part and follows it', () => {
    const store = createStore({ a: 1, b: 1 })
    render(<Reader store={store} />)
    expect(screen.getByTestId('a')).toHaveTextContent('1')

    act(() => store.setState({ a: 2, b: 1 }))
    expect(screen.getByTestId('a')).toHaveTextContent('2')
  })

  it('does not render again for a change outside the selected part', () => {
    const store = createStore({ a: 1, b: 1 })
    let renders = 0
    function Counting() {
      renders += 1
      return <Reader store={store} />
    }
    render(<Counting />)
    const before = renders

    act(() => store.setState((previous) => ({ ...previous, b: 2 })))

    expect(renders).toBe(before)
  })
})

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NowInput } from '../../src/states/format.ts'
import { useResolvedNow } from '../../src/states/use-now.ts'

function Clock({ now }: { now?: NowInput }) {
  return <output>{useResolvedNow(now)}</output>
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-13T14:00:03Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useResolvedNow', () => {
  it('returns the given time and runs no timer', () => {
    render(<Clock now="2026-10-13T14:10:00Z" />)

    expect(screen.getByRole('status')).toHaveTextContent(String(Date.parse('2026-10-13T14:10:00Z')))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('follows the shared clock, one tick at a time', () => {
    render(<Clock />)
    const first = Number(screen.getByRole('status').textContent)
    expect(first).toBe(Date.parse('2026-10-13T14:00:00Z'))

    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(Number(screen.getByRole('status').textContent)).toBe(Date.parse('2026-10-13T14:00:10Z'))
  })

  it('shares one timer between components and stops it when the last one unmounts', () => {
    const one = render(<Clock />)
    const two = render(<Clock />)
    expect(vi.getTimerCount()).toBe(1)

    one.unmount()
    expect(vi.getTimerCount()).toBe(1)

    two.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

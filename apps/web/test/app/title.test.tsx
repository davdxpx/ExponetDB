import '@testing-library/jest-dom/vitest'
import { cleanup, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatTitle, navigationLabel, titleOf } from '../../src/app/title.ts'
import { FakeServer, meOf, mountApp } from '../account/support.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.title = ''
})

describe('the document title', () => {
  it('reads "<Page> · ExponetDB", or the product name alone', () => {
    expect(formatTitle('Sign in')).toBe('Sign in · ExponetDB')
    expect(formatTitle(undefined)).toBe('ExponetDB')
    expect(formatTitle('')).toBe('ExponetDB')
  })

  it('names a page by its route first, then by the navigation, never by the address', () => {
    expect(titleOf('/changes/plans/pln_x', [undefined, 'plans.page.title'])).toBe(
      'Plan review · ExponetDB',
    )
    expect(titleOf('/changes/plans', [])).toBe('Plans · ExponetDB')
    expect(titleOf('/changes', [])).toBe('All changes · ExponetDB')
    expect(titleOf('/', [])).toBe('Overview · ExponetDB')
    expect(titleOf('/t/shop/app/production', [])).toBe('Overview · ExponetDB')
    expect(titleOf('/t/shop/app/production/schema/tables', [])).toBe('Schema · ExponetDB')
    expect(navigationLabel('/t/<script>/x/y/locks')).toBe('Locks')
    // An address the navigation does not know names nothing.
    expect(titleOf('/access/<img src=x>', [])).toBe('ExponetDB')
    expect(titleOf('/t/a/b/c/<b>', [])).toBe('ExponetDB')
  })

  it('follows the page: sign-in, then the pages of the shell', async () => {
    const signedOut = new FakeServer().signedOut()
    mountApp('/login', signedOut)
    await waitFor(() => expect(document.title).toBe('Sign in · ExponetDB'))
    cleanup()
    vi.restoreAllMocks()

    const signedIn = new FakeServer().signedIn(meOf())
    const { router } = mountApp('/account', signedIn)
    await waitFor(() => expect(document.title).toBe('Your account · ExponetDB'))
    await act(() => router.navigate({ href: '/changes/plans' }))
    await waitFor(() => expect(document.title).toBe('Plans · ExponetDB'))
    await act(() => router.navigate({ href: '/connect' }))
    await waitFor(() => expect(document.title).toBe('Connect an MCP client · ExponetDB'))
    await act(() => router.navigate({ href: '/no/such/page' }))
    await waitFor(() => expect(document.title).toBe('Page not found · ExponetDB'))
  })
})

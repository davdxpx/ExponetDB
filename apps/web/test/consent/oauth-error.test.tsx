import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { AUTHORIZE_ERROR_FALLBACK, AUTHORIZE_ERRORS } from '../../src/lib/navigation/links.ts'
import { mountApp, OAuthWorld } from './support.tsx'

afterEach(cleanup)

async function openError(search: string) {
  const world = new OAuthWorld()
  mountApp(`/oauth/error${search}`, world)
  await screen.findByRole('heading', { level: 1, name: 'Sign-in not possible' })
  return world
}

describe('the authorization error page', () => {
  for (const [reason, text] of Object.entries(AUTHORIZE_ERRORS)) {
    it(`shows the fixed text of ${reason}`, async () => {
      await openError(`?reason=${reason}`)
      expect(document.getElementById('oauth-error')).toHaveTextContent(text)
    })
  }

  const hostile = [
    '',
    '?reason=',
    '?reason=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
    '?reason=client_not_approved_but_not_really',
    '?reason=__proto__',
    '?reason=toString',
    '?reason=Client_Unknown',
    '?other=client_unknown',
    '?reason=%E2%80%AEevil',
  ]
  for (const search of hostile) {
    it(`shows the fixed fallback for "${search}" and echoes nothing`, async () => {
      await openError(search)
      expect(document.getElementById('oauth-error')).toHaveTextContent(AUTHORIZE_ERROR_FALLBACK)
      expect(document.body.textContent).not.toMatch(/img|onerror|proto|toString|evil|really/)
      expect(document.querySelector('img')).toBeNull()
    })
  }

  it('takes the first reason only and needs no session', async () => {
    const world = await openError('?reason=rate_limited&reason=client_unknown')
    expect(document.getElementById('oauth-error')).toHaveTextContent(AUTHORIZE_ERRORS.rate_limited)
    expect(world.paths()).toEqual([])
  })

  it('has no accessibility violations', async () => {
    await openError('?reason=client_not_approved')
    expect(await axeViolations()).toEqual([])
  })
})

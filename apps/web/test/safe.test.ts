import { describe, expect, it } from 'vitest'
import {
  AUTHORIZE_ERRORS,
  authorizeError,
  csrfToken,
  groupSecret,
  linkToken,
  loginUrl,
  PAGES,
  pageOf,
  qrPath,
  requestHandle,
  safeReturnTo,
} from '../src/safe.ts'

const OP = 'op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
const TOKEN = 'A'.repeat(43)

describe('returnTo (no open redirect)', () => {
  it('accepts only the account and approvals pages of this origin', () => {
    expect(safeReturnTo('/account')).toBe('/account')
    expect(safeReturnTo('/approvals')).toBe('/approvals')
    expect(safeReturnTo(`/approvals#operation=${OP}`)).toBe(`/approvals#operation=${OP}`)
  })

  it('accepts the consent page with a request handle, device entry and administration pages', () => {
    expect(safeReturnTo(`/oauth/consent#request=exar_${TOKEN}`)).toBe(
      `/oauth/consent#request=exar_${TOKEN}`,
    )
    expect(safeReturnTo('/oauth/device')).toBe('/oauth/device')
    expect(safeReturnTo('/admin/clients')).toBe('/admin/clients')
    expect(safeReturnTo('/admin/service-accounts')).toBe('/admin/service-accounts')
    expect(safeReturnTo('/step-up#id=stu_01M4QT02MQ05WZ8J29C134Y45A')).toBe(
      '/step-up#id=stu_01M4QT02MQ05WZ8J29C134Y45A',
    )
    expect(safeReturnTo('/step-up#id=evil')).toBe('/account')
    expect(safeReturnTo('/step-up')).toBe('/account')
  })

  it('falls back for everything else', () => {
    for (const hostile of [
      null,
      undefined,
      '',
      'https://evil.example/account',
      '//evil.example/account',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      '/account?x=1',
      '/account#x',
      '/approvals#operation=op_short',
      `/approvals#operation=${OP}&x`,
      '/login',
      '/setup',
      '/%2F%2Fevil.example',
      ' /account',
      '/account/',
      '/ACCOUNT',
      '/oauth/consent',
      `/oauth/consent#request=exar_${TOKEN}x`,
      `/oauth/consent#request=exar_${TOKEN}&x=1`,
      `/oauth/consent#request=exat_${TOKEN}`,
      `/oauth/consent?request=exar_${TOKEN}`,
      '/oauth/device#code=BCDF-GHJK',
      '/oauth/device?user_code=BCDF-GHJK',
      '/oauth/error',
      '/oauth/authorize',
      '/admin/clients#x',
      '/admin/clients/',
      '/admin',
    ]) {
      expect(safeReturnTo(hostile), String(hostile)).toBe('/account')
    }
  })

  it('builds the sign-in URL with an encoded safe target only', () => {
    expect(loginUrl('/account')).toBe('/login')
    expect(loginUrl(`/approvals#operation=${OP}`)).toBe(
      `/login?returnTo=${encodeURIComponent(`/approvals#operation=${OP}`)}`,
    )
    expect(loginUrl('https://evil.example')).toBe('/login')
  })
})

describe('link tokens', () => {
  it('accepts the token kind of the page only', () => {
    expect(linkToken('/setup', `#token=exsu_${TOKEN}`)).toBe(`exsu_${TOKEN}`)
    expect(linkToken('/invite', `#token=exiv_${TOKEN}`)).toBe(`exiv_${TOKEN}`)
    expect(linkToken('/recover', `#token=exrc_${TOKEN}`)).toBe(`exrc_${TOKEN}`)
    expect(linkToken('/setup', `#token=exiv_${TOKEN}`)).toBeUndefined()
    expect(linkToken('/invite', `#token=exrc_${TOKEN}`)).toBeUndefined()
  })

  it('refuses malformed fragments', () => {
    expect(linkToken('/setup', '')).toBeUndefined()
    expect(linkToken('/setup', `#token=exsu_${TOKEN}x`)).toBeUndefined()
    expect(linkToken('/setup', `#token=exsu_${TOKEN}&a=b`)).toBeUndefined()
    expect(linkToken('/setup', `?token=exsu_${TOKEN}`)).toBeUndefined()
  })
})

describe('OAuth pages', () => {
  it('takes the request handle from the fragment only in its exact form', () => {
    expect(requestHandle(`#request=exar_${TOKEN}`)).toBe(`exar_${TOKEN}`)
    for (const hostile of [
      '',
      `#request=exar_${TOKEN}x`,
      `#request=exar_${TOKEN}&a=b`,
      `#request=exac_${TOKEN}`,
      `?request=exar_${TOKEN}`,
      `#request=exar_${'<'.repeat(43)}`,
    ]) {
      expect(requestHandle(hostile), hostile).toBeUndefined()
    }
  })

  it('shows fixed text for the authorization errors and never echoes the query', () => {
    expect(authorizeError('?reason=client_unknown')).toBe(AUTHORIZE_ERRORS.client_unknown)
    expect(authorizeError('?reason=redirect_uri_invalid')).toBe(
      AUTHORIZE_ERRORS.redirect_uri_invalid,
    )
    for (const hostile of ['', '?reason=<script>', '?reason=toString', '?reason=__proto__']) {
      expect(authorizeError(hostile), hostile).toBe('The sign-in request could not be processed.')
    }
  })
})

describe('CSRF cookie', () => {
  it('reads the CSRF cookie only, and only a well-formed value', () => {
    expect(csrfToken('a=b; __Host-exdb_csrf=exck_abc-_123; c=d')).toBe('exck_abc-_123')
    expect(csrfToken('__Host-exdb_session=exst_x')).toBeUndefined()
    expect(csrfToken('__Host-exdb_csrf=<script>')).toBeUndefined()
    expect(csrfToken('x__Host-exdb_csrf=exck_a')).toBeUndefined()
  })
})

describe('pages and QR', () => {
  it('knows exactly the pages the server answers', () => {
    expect(PAGES).toEqual([
      '/',
      '/login',
      '/setup',
      '/invite',
      '/recover',
      '/account',
      '/approvals',
      '/step-up',
      '/oauth/consent',
      '/oauth/device',
      '/oauth/error',
      '/admin/clients',
      '/admin/service-accounts',
    ])
    expect(pageOf('/account')).toBe('/account')
    expect(pageOf('/admin')).toBeUndefined()
    expect(pageOf('/oauth/authorize')).toBeUndefined()
  })

  it('draws dark modules only, offset by the quiet zone', () => {
    expect(qrPath(['10', '01'])).toBe('M4 4h1v1h-1zM5 5h1v1h-1z')
    expect(qrPath(['00'])).toBe('')
  })

  it('groups the TOTP secret for reading', () => {
    expect(groupSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ')
  })
})

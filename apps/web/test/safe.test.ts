import { describe, expect, it } from 'vitest'
import {
  csrfToken,
  groupSecret,
  linkToken,
  loginUrl,
  PAGES,
  pageOf,
  qrPath,
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
    ])
    expect(pageOf('/account')).toBe('/account')
    expect(pageOf('/admin')).toBeUndefined()
  })

  it('draws dark modules only, offset by the quiet zone', () => {
    expect(qrPath(['10', '01'])).toBe('M4 4h1v1h-1zM5 5h1v1h-1z')
    expect(qrPath(['00'])).toBe('')
  })

  it('groups the TOTP secret for reading', () => {
    expect(groupSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ')
  })
})

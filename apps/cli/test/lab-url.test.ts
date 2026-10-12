import { describe, expect, it } from 'vitest'
import { controlStoreUrl } from '../src/lab/stack.ts'

/** How `pg` (pg-connection-string) reads a connection URL. */
function parsed(href: string) {
  const url = new URL(href)
  return {
    protocol: url.protocol,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: url.port,
    database: decodeURIComponent(url.pathname.slice(1)),
  }
}

describe('lab Control Store URL', () => {
  const passwords = [
    'plain-base64url_value',
    'p@ss:w/rd?x#y%z',
    '%41%25%',
    ' spaced  value ',
    'quotes\'"`[]{}|^\\',
    'ünïcödé-€',
    '=;&+$,!~*()',
  ]

  for (const password of passwords) {
    it(`round-trips the password ${JSON.stringify(password)}`, () => {
      const href = controlStoreUrl('exdb-lab-1234-control', 'exdb_serve', password)
      expect(parsed(href)).toEqual({
        protocol: 'postgres:',
        user: 'exdb_serve',
        password,
        host: 'exdb-lab-1234-control',
        port: '5432',
        database: 'exponetdb_control',
      })
    })
  }

  it('round-trips a login with reserved characters', () => {
    const href = controlStoreUrl('control', 'a@b:c', 'secret')
    expect(parsed(href).user).toBe('a@b:c')
    expect(parsed(href).password).toBe('secret')
  })
})

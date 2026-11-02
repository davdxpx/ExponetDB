import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countLine } from '../src/output/format.ts'
import { FakeApi, ok } from './fake-api.ts'

/**
 * TC-064 (CLI read polish): `--limit 0` and `--limit -1` answered one item plus a `Next:` cursor,
 * `--limit 10001` was accepted although the help says "1 to 10000", and the count line said
 * "2 identitys".
 */
let api: FakeApi

beforeEach(async () => {
  api = new FakeApi()
  await api.open()
  api.on('GET', '/servers', ok('listServers', { items: [], nextCursor: null }))
})
afterEach(() => api.close())

describe('--limit (TC-064)', () => {
  it.each(['0', '-1', '10001', '1.5'])(
    'refuses %s as a usage error and asks nothing',
    async (limit) => {
      const r = await api.cli(['server', 'list', '--limit', limit])
      expect(r.code).toBe(2)
      expect(r.stderr).toMatch(/--limit/)
      expect(api.requests.filter((q) => q.path === '/servers')).toEqual([])
    },
  )

  it.each(['1', '50', '10000'])('takes %s', async (limit) => {
    expect((await api.cli(['server', 'list', '--limit', limit])).code).toBe(0)
  })
})

describe('the count line (TC-064)', () => {
  it.each([
    [1, 'identity', '1 identity'],
    [2, 'identity', '2 identities'],
    [2, 'target', '2 targets'],
    [2, 'index', '2 indexes'],
    [0, 'match', '0 matches'],
    [2, 'key', '2 keys'],
  ])('%i %s reads %s', (n, noun, text) => {
    expect(countLine(n, noun, false)).toMatchObject({ lines: [text] })
  })
})

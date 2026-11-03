import { MIN_CLI_VERSION, ROUTE_LIST } from '@exponetdb/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { matchesContract } from '../src/cli/remote.ts'
import { CLI_VERSION, olderThan } from '../src/version.ts'
import { FakeApi, INSTALLATION, ok, ulid } from './fake-api.ts'

/**
 * TC-040 (E4): an older CLI answered `RESPONSE_INVALID` with a status and a request id as soon as a
 * newer server added a field to a strict object or answered another REST major, and
 * `incompatible_server` was dead code because the strict installation parse failed first.
 */
const reveal = ROUTE_LIST.find((r) => r.path === '/enrollment-tokens/{tokenId}/reveal')

describe('a response with a field this CLI does not know', () => {
  const body = {
    tokenId: ulid('ent', 1),
    serverId: ulid('srv', 2),
    token: 'exdbt1.abcdef',
    expiresAt: '2026-10-26T10:00:00.000Z',
  }

  it('is accepted: versioning.md §2 says a client ignores unknown fields', () => {
    expect(reveal).toBeDefined()
    const id = reveal?.operationId as string
    expect(matchesContract(id, body)).toBe(true)
    expect(matchesContract(id, { ...body, addedInTheNextRelease: 1 })).toBe(true)
  })

  it('is still refused when a known field has the wrong shape', () => {
    const id = reveal?.operationId as string
    expect(matchesContract(id, { ...body, token: 5 })).toBe(false)
    expect(matchesContract(id, { ...body, token: undefined })).toBe(false)
    expect(matchesContract(id, { ...body, addedInTheNextRelease: 1, tokenId: 'nope' })).toBe(false)
  })
})

describe('a server this CLI cannot speak to', () => {
  let api: FakeApi
  beforeEach(async () => {
    api = new FakeApi()
    await api.open()
  })
  afterEach(() => api.close())

  it('names both versions when the server speaks another REST major', async () => {
    api.installation = {
      ...INSTALLATION,
      version: '9.0.0',
      contracts: { ...INSTALLATION.contracts, restApi: 'v2' },
    }
    const r = await api.cli(['node', 'list'])
    expect(r.code).toBe(5)
    expect(r.stderr).toContain('incompatible_server')
    expect(r.stderr).toContain('9.0.0')
    expect(r.stderr).toContain(CLI_VERSION)
  })

  it('says the CLI is outdated when the server names a newer minimum', async () => {
    api.installation = { ...INSTALLATION, version: '9.0.0', minCliVersion: '9.0.0' }
    const r = await api.cli(['node', 'list'])
    expect(r.code).toBe(5)
    expect(r.stderr).toContain('cli_outdated')
    expect(r.stderr).toMatch(/9\.0\.0 or newer/)
  })

  it('never prints server text of an unexpected shape in the message', async () => {
    api.installation = {
      ...INSTALLATION,
      version: `9.0.0\u001b[31m${'x'.repeat(500)}`,
      contracts: { ...INSTALLATION.contracts, restApi: `v2\u001b]0;pwn\u0007` },
    }
    const r = await api.cli(['node', 'list'])
    expect(r.code).toBe(5)
    expect(r.stderr).toContain('incompatible_server')
    expect(r.stderr).toContain('(unknown)')
    expect(r.stderr).not.toContain('\u001b')
    expect(r.stderr).not.toContain('pwn')
    expect(r.stderr.length).toBeLessThan(600)
  })

  it('is never above the CLI it ships with: the server minimum cannot lock out its own release', () => {
    expect(olderThan(CLI_VERSION, MIN_CLI_VERSION)).toBe(false)
  })

  it('does not refuse a CLI at or above the minimum', async () => {
    api.installation = { ...INSTALLATION, minCliVersion: CLI_VERSION }
    api.on('GET', '/nodes', ok('listNodes', { items: [], nextCursor: null }))
    expect((await api.cli(['node', 'list'])).code).toBe(0)
  })
})

describe('a contract mismatch against a newer server', () => {
  let api: FakeApi
  const node = (state: string) => ({
    id: ulid('nod', 4),
    serverId: ulid('srv', 5),
    state,
    agentVersion: '0.7.0',
    protocolMajor: 1,
    lastHeartbeatAt: null,
    clockSkewMs: null,
    capabilities: [],
  })
  beforeEach(async () => {
    api = new FakeApi()
    await api.open()
    // A value of a closed enum the next release added.
    api.on('GET', '/nodes', [200, { items: [node('quarantined')], nextCursor: null }])
  })
  afterEach(() => api.close())

  it('tells the person to update the CLI, and prints no empty table', async () => {
    api.installation = { ...INSTALLATION, version: '9.0.0' }
    const r = await api.cli(['node', 'list'])
    expect(r.code).toBe(5)
    expect(r.stderr).toContain('RESPONSE_INVALID')
    expect(r.stderr).toMatch(/server 9\.0\.0 is newer than this CLI/)
    expect(r.stderr).toContain('update')
    expect(r.stdout).not.toMatch(/No nodes/i)
  })

  it('keeps the plain refusal when the server is not newer', async () => {
    api.installation = { ...INSTALLATION, version: CLI_VERSION }
    const r = await api.cli(['node', 'list'])
    expect(r.code).toBe(5)
    expect(r.stderr).toContain('RESPONSE_INVALID')
    expect(r.stderr).not.toMatch(/is newer than this CLI/)
  })
})

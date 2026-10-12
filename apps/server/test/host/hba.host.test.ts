import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hostScenario } from '../support/host-world.ts'

/**
 * Host scenario: pg_hba.conf through the helper (G5 item 7), on a cluster of
 * its own. A managed block is written and verified; a block that would lock
 * the agent out is refused on the host and the file is put back byte for
 * byte; the agent can still connect afterwards.
 */
const w = hostScenario({ scenario: 'hba' })

const rule = {
  type: 'hostssl',
  database: ['app'],
  user: ['app_user'],
  address: '10.1.0.0/16',
  method: 'scram-sha-256',
  map: null,
}

describe('pg_hba through the managed block (host scenario)', () => {
  it('writes a managed block and verifies it by a fresh read', async () => {
    await w.inspect('postgres.hba.inspect@2')
    const hba = await w.planAndApply({
      kind: 'postgres.hba.apply',
      managedRules: [rule],
      protectedAccess: [],
    })
    expect([hba.state, hba.verificationOutcome], w.lines.join('')).toEqual(['succeeded', 'passed'])
    const text = readFileSync(w.instance.hbaFile, 'utf8')
    expect(text).toContain('10.1.0.0/16')
    // Foreign rules stay: the agent's own access line is untouched.
    expect(text).toContain('local all exponetdb_node peer map=exponetdb\n')
  })

  it('refuses a block that would lock the agent out, and puts the file back', async () => {
    const before = readFileSync(w.instance.hbaFile)
    await w.inspect('postgres.hba.inspect@2')
    const lockout = await w.planAndApply({
      kind: 'postgres.hba.apply',
      managedRules: [
        {
          type: 'local',
          database: ['all'],
          user: ['all'],
          address: null,
          method: 'reject',
          map: null,
        },
      ],
      protectedAccess: [],
    })
    expect([lockout.state, lockout.applyOutcome]).toEqual(['failed', 'not_applied'])
    expect(Buffer.compare(readFileSync(w.instance.hbaFile), before)).toBe(0)
    expect(await w.psql('SELECT 1')).toBe('1')
    // The node still reads the cluster afterwards.
    await w.inspect('postgres.hba.inspect@2')
  })

  it('removes the managed block again', async () => {
    await w.inspect('postgres.hba.inspect@2')
    const removed = await w.planAndApply({
      kind: 'postgres.hba.apply',
      managedRules: [],
      protectedAccess: [],
    })
    expect([removed.state, removed.verificationOutcome]).toEqual(['succeeded', 'passed'])
    expect(readFileSync(w.instance.hbaFile, 'utf8')).not.toContain('10.1.0.0/16')
  })
})

// R2 probe (TC-018 neighbour): the remediation of HBA_WOULD_LOCK_OUT says "or name it in protectedAccess".
// protectedAccess is the list that is checked, so naming an access there cannot make a reject-all block pass.
// Copy to packages/nodes/test/.
import { describe, expect, it } from 'vitest'
import { hbaLockOut } from '../src/hba-lockout.ts'

const reject = { type: 'hostssl', database: ['all'], user: ['all'], address: 'all', method: 'reject', map: null } as never
const access = { role: 'exponetdb_app', database: 'app', address: '203.0.113.7', method: 'scram-sha-256' } as never
describe('R2 hba probe', () => {
  it('an access named in protectedAccess is still refused by a reject-all block', () => {
    const named = hbaLockOut([reject], [access])
    const notNamed = hbaLockOut([reject], [])
    console.log('R2-HBA protectedAccess=[the access]:', JSON.stringify(named), '| protectedAccess=[] and nothing derived:', JSON.stringify(notNamed ?? null))
    expect(named).toBeDefined()
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { eventually, hostScenario } from '../support/host-world.ts'

/**
 * Host scenario: the node's own records broken or lost (architecture.md §2
 * and §4), on a node of its own. A corrupted or missing agent journal makes
 * the agent refuse every job (journal_corrupt) and run nothing; restored, it
 * works again. A lost helper ledger makes the helper refuse every effect
 * while its reads stay available; nothing on the host changes.
 */
const w = hostScenario({ scenario: 'journal' })

async function refusedRead() {
  const r = await w.call('POST', `/api/v1/nodes/${w.requireNode().nodeId}/inspections`, {
    capability: 'postgres.status@1',
    clusterId: w.clusterId,
    args: {},
  })
  expect(r.status).toBe(202)
  return w.finished(r.body.id)
}

describe('a broken or lost journal and a lost helper ledger (host scenario)', () => {
  it('a corrupted journal: every job is refused and nothing runs; restored, the node works', async () => {
    await w.inspect('postgres.status@1')
    const journalFile = join(w.requireNode().state, 'journal', 'journal.log')
    await w.stopAgent()
    const intact = readFileSync(journalFile)
    const broken = Buffer.from(intact)
    const middle = broken.indexOf('"hash":"sha256:', Math.floor(broken.length / 2)) + 20
    broken[middle] = broken[middle] === 0x30 ? 0x31 : 0x30
    await writeFile(journalFile, broken)
    await w.startAgent()
    const corrupt = await refusedRead()
    expect([corrupt.state, corrupt.applyOutcome], w.lines.join('')).toEqual([
      'failed',
      'not_applied',
    ])
    await w.stopAgent()
    await writeFile(journalFile, intact)
    await w.startAgent()
    await w.inspect('postgres.status@1')
  })

  it('a missing journal after enrollment: every job is refused, none is created again by the agent', async () => {
    const journalFile = join(w.requireNode().state, 'journal', 'journal.log')
    await w.stopAgent()
    await rename(journalFile, `${journalFile}.aside`)
    await w.startAgent()
    const missing = await refusedRead()
    expect([missing.state, missing.applyOutcome], w.lines.join('')).toEqual([
      'failed',
      'not_applied',
    ])
    await w.stopAgent()
    await rm(journalFile, { force: true })
    await rename(`${journalFile}.aside`, journalFile)
    await w.startAgent()
    await w.inspect('postgres.status@1')
  })

  it('a lost helper ledger: every effect is refused, reads stay available, the host is unchanged', async () => {
    const before = await w.psql('SHOW work_mem')
    const fragmentOf = () =>
      existsSync(w.instance.managedInclude) ? readFileSync(w.instance.managedInclude, 'utf8') : null
    const fragment = fragmentOf()
    // Under systemd the helper is socket-activated: it starts, and creates its ledger, at
    // its first connection. A read through the helper makes sure that start has happened
    // (the reads before go to the agent alone), so there is a ledger to lose.
    await w.inspect('postgres.config.inspect@2')
    await w.stopHelper()
    await rm(join(w.requireNode().helperDir, 'state', 'effects.log'))
    const mark = w.logMark()
    await w.startHelper()
    const refused = await w.finished(await w.configChange('15MB'), 400_000)
    expect([refused.state, refused.applyOutcome], w.lines.join('')).toEqual([
      'failed',
      'not_applied',
    ])
    expect(await w.psql('SHOW work_mem')).toBe(before)
    expect(fragmentOf()).toBe(fragment)
    await eventually(
      'the helper to say its ledger is lost',
      () => w.logs(mark),
      (text) => text.includes('the effect ledger is lost'),
      30_000,
    )
    // Read-only operations of the helper stay available.
    await w.inspect('postgres.config.inspect@2')
  })
})

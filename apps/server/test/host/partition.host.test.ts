import { rm } from 'node:fs/promises'
import { newId } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import { eventually, hostScenario } from '../support/host-world.ts'

/**
 * Host scenario: a partition, a lost lease and a late result (G5 item 4,
 * control-plane.md §9.4), on a node of its own. The agent is held after the
 * effect; the gateway goes away or the worker stops; nothing is decided
 * while the job's statement is missing; the statement delivered later
 * decides; one apply job and one effect, never a second.
 */
const w = hostScenario({ scenario: 'partition' })
const APPLY = 'postgres.config.apply@2'

describe('a partition, a lost lease and a late result (host scenario)', () => {
  it('gateway gone and lease taken over: outcome unknown, nothing decided, the late statement decides', async () => {
    await w.inject(APPLY, 'executed', 'hold')
    const held = await w.configChange('7MB')
    await eventually(
      'the held job to run',
      () => w.applyJobs(held),
      (rows) => rows[0]?.state === 'running',
    )
    await w.stopGateway()
    await w.sql(
      `UPDATE operations.operations SET lease_owner = $2, lease_expires_at = clock_timestamp() + interval '2 seconds'
        WHERE operation_id = $1`,
      [held, newId('prc', Date.now())],
    )
    await eventually(
      'the job lease to run out',
      () => w.applyJobs(held),
      (rows) => rows[0]?.state === 'outcome_unknown',
      150_000,
    )
    const open = await w.sql('SELECT state FROM operations.operations WHERE operation_id = $1', [
      held,
    ])
    expect(['running', 'needs_reconciliation']).toContain(open[0]?.state)
    await rm(w.requireNode().faults)
    w.startGateway()
    const done = await w.finished(held, 400_000)
    expect([done.state, done.applyOutcome, done.verificationOutcome], w.lines.join('')).toEqual([
      'succeeded',
      'applied',
      'passed',
    ])
    expect(await w.psql('SHOW work_mem')).toBe('7MB')
    const events = await w.sql(
      `SELECT kind FROM operations.operation_events WHERE operation_id = $1`,
      [held],
    )
    expect(events.map((e) => e.kind)).toContain('lease_taken_over')
    const late = await w.sql(
      `SELECT state, node_signature_valid FROM nodes.jobs WHERE operation_id = $1 AND capability = $2`,
      [held, APPLY],
    )
    expect(late).toEqual([{ state: 'completed', node_signature_valid: true }])
  })

  it('the worker stops while the job runs: a restarted worker takes the operation over; one job, one effect', async () => {
    await w.inject(APPLY, 'executed', 'hold')
    const held = await w.configChange('8MB')
    await eventually(
      'the held job to run',
      () => w.applyJobs(held),
      (rows) => rows[0]?.state === 'running',
    )
    await w.stopWorker()
    await rm(w.requireNode().faults)
    // The statement reaches the gateway while no worker runs.
    await eventually(
      'the statement stored by the gateway',
      () => w.applyJobs(held),
      (rows) => rows[0]?.state === 'completed',
      120_000,
    )
    // A graceful stop may finish the step it was in (the operation then waits
    // in verifying); it never ends the operation without a worker.
    const waiting = await w.sql('SELECT state FROM operations.operations WHERE operation_id = $1', [
      held,
    ])
    expect(['running', 'needs_reconciliation', 'verifying']).toContain(waiting[0]?.state)
    w.startWorker()
    const done = await w.finished(held, 400_000)
    expect([done.state, done.applyOutcome, done.verificationOutcome], w.lines.join('')).toEqual([
      'succeeded',
      'applied',
      'passed',
    ])
    expect(await w.psql('SHOW work_mem')).toBe('8MB')
    expect((await w.applyJobs(held)).length).toBe(1)
  })
})

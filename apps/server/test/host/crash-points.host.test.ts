import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hostScenario } from '../support/host-world.ts'

/**
 * Host scenario: the agent killed (SIGKILL) at every job boundary of a
 * configuration change, and the root helper killed at its effect points
 * (G5 item 4, control-plane.md §9.4, ADR-0025), on a cluster of its own.
 * systemd (or the world without it) restarts the process; each case ends in
 * the outcome the host proves, with one apply job and never a second effect.
 */
const w = hostScenario({ scenario: 'crash-points' })
const APPLY = 'postgres.config.apply@2'

async function statementOf(operationId: string) {
  const jobs = await w.applyJobs(operationId)
  expect(jobs.length, `apply jobs of ${operationId}`).toBe(1)
  const rows = await w.sql(
    `SELECT completion->>'outcome' AS outcome, completion->'steps' AS steps FROM nodes.jobs WHERE job_id = $1`,
    [jobs[0]?.job_id],
  )
  return {
    outcome: rows[0]?.outcome as string | undefined,
    steps: ((rows[0]?.steps ?? []) as { name: string; state: string }[]).map(
      (x) => `${x.name}:${x.state}`,
    ),
  }
}

describe('a crash at every job, statement, delivery and helper point (host scenario)', () => {
  it('accepted: the job never runs; its one statement says so', async () => {
    await w.inject(APPLY, 'accepted', 'crash')
    const op = await w.finished(await w.configChange('9MB'), 300_000)
    expect([op.state, op.applyOutcome, op.errorCode], w.lines.join('')).toEqual([
      'failed',
      'not_applied',
      'JOB_EXPIRED',
    ])
    expect(existsSync(w.requireNode().faults)).toBe(false)
    expect(await w.psql('SHOW work_mem')).toBe('4MB')
  })

  it('effect, before the host changed: nothing is decided before the settle time, then not applied', async () => {
    await w.inject(APPLY, 'effect', 'crash')
    const op = await w.finished(await w.configChange('9MB'), 400_000)
    expect([op.state, op.applyOutcome], w.lines.join('')).toEqual(['failed', 'not_applied'])
    expect(await w.psql('SHOW work_mem')).toBe('4MB')
    expect((await w.applyJobs(op.id)).length).toBe(1)
  })

  it('executed, after the effect and before the statement: the journaled steps prove the reload (ADR-0025)', async () => {
    await w.inject(APPLY, 'executed', 'crash')
    const op = await w.finished(await w.configChange('9MB'), 400_000)
    expect([op.state, op.applyOutcome, op.verificationOutcome], w.lines.join('')).toEqual([
      'succeeded',
      'applied',
      'passed',
    ])
    expect(await w.psql('SHOW work_mem')).toBe('9MB')
    expect(await statementOf(op.id)).toEqual({
      outcome: 'failed',
      steps: [
        'check:succeeded',
        'write_fragment:running',
        'write_fragment:succeeded',
        'reload:succeeded',
      ],
    })
  })

  let value = '9MB'
  for (const point of ['stored', 'stated', 'closed', 'acknowledged', 'delivered'] as const) {
    it(`${point}: the one stored statement decides; one job, one effect, never signed again`, async () => {
      value = value === '9MB' ? '10MB' : '9MB'
      await w.inject(APPLY, point, 'crash')
      const op = await w.finished(await w.configChange(value), 400_000)
      expect([point, op.state, op.applyOutcome, op.verificationOutcome], w.lines.join('')).toEqual([
        point,
        'succeeded',
        'applied',
        'passed',
      ])
      expect(await w.psql('SHOW work_mem')).toBe(value)
      expect((await statementOf(op.id)).outcome).toBe('succeeded')
      expect(existsSync(w.requireNode().faults), point).toBe(false)
    })
  }

  it('helper admitted: the helper recorded the effect and died before it: not applied, and the job is spent', async () => {
    const before = await w.psql('SHOW work_mem')
    await w.injectHelper('config.patch_fragment', 'admitted', 'crash')
    const op = await w.finished(await w.configChange('12MB'), 400_000)
    expect([op.state, op.applyOutcome], w.lines.join('')).toEqual(['failed', 'not_applied'])
    expect(await w.psql('SHOW work_mem')).toBe(before)
    expect(existsSync(w.requireNode().helperFaults)).toBe(false)
    expect((await w.applyJobs(op.id)).length).toBe(1)
    // A new plan is a new job: it runs.
    const next = await w.finished(await w.configChange('12MB'))
    expect([next.state, next.verificationOutcome]).toEqual(['succeeded', 'passed'])
    expect(await w.psql('SHOW work_mem')).toBe('12MB')
  })

  it('helper performed: the fragment was written and the agent never heard; applied, not proven, never run again', async () => {
    const before = await w.psql('SHOW work_mem')
    await w.injectHelper('config.patch_fragment', 'performed', 'crash')
    const op = await w.finished(await w.configChange('13MB'), 400_000)
    expect(existsSync(w.requireNode().helperFaults)).toBe(false)
    // The host shows the write (reconciled: applied), but no statement of the
    // job proves a reload, so nothing claims the value is in effect: the
    // operation stops for a person, and the job never runs again.
    expect(
      [op.state, op.applyOutcome, op.verificationOutcome, op.errorCode],
      w.lines.join(''),
    ).toEqual(['needs_attention', 'applied', 'error', 'VERIFICATION_ERROR'])
    expect(await statementOf(op.id)).toEqual({
      outcome: 'failed',
      steps: ['check:succeeded', 'write_fragment:running'],
    })
    expect(readFileSync(w.instance.managedInclude, 'utf8')).toContain("work_mem = '13MB'")
    expect(await w.psql('SHOW work_mem')).toBe(before)
  })
})

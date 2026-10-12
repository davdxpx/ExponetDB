import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostScenario, run, SYSTEMD } from '../support/host-world.ts'

/**
 * Host scenario: configuration through the managed fragment (OD-20,
 * control-plane.md §9), on a cluster of its own. A value is planned against
 * a fresh read, applied by a signed job and verified by a separate read; a
 * host change after planning makes the plan stale; a value the postmaster
 * command line outranks is never reported as in effect; reload and, under
 * systemd, restart.
 */
const w = hostScenario({ scenario: 'config' })

describe('configuration through the managed fragment (host scenario)', () => {
  it('applies a value, verifies it by a fresh read, and removes it again', async () => {
    await w.inspect('postgres.status@1')
    // A plan needs a recent basis observation of exactly its change.
    const noBasis = await w.call('POST', `/api/v1/nodes/${w.requireNode().nodeId}/plans`, {
      clusterId: w.clusterId,
      change: {
        kind: 'postgres.config.apply',
        changes: [{ name: 'work_mem', value: '7MB' }],
        reload: true,
      },
    })
    expect([noBasis.status, noBasis.body?.code]).toEqual([409, 'NODE_OBSERVATION_STALE'])
    const applied = await w.finished(await w.configChange('7MB'))
    expect(
      [applied.state, applied.applyOutcome, applied.verificationOutcome],
      w.lines.join(''),
    ).toEqual(['succeeded', 'applied', 'passed'])
    expect(await w.psql('SHOW work_mem')).toBe('7MB')
    // The job's own signed statement proves the reload by its journaled steps (ADR-0025).
    const jobs = await w.applyJobs(applied.id)
    expect(jobs.map((j) => j.outcome)).toEqual(['succeeded'])
    const removed = await w.finished(await w.configChange(null))
    expect([removed.state, removed.verificationOutcome]).toEqual(['succeeded', 'passed'])
    expect(await w.psql('SHOW work_mem')).toBe('4MB')
  })

  it('makes a plan stale when the host changes after planning (ALTER SYSTEM), and applies nothing', async () => {
    const changes = [{ name: 'work_mem', value: '8MB' }]
    await w.inspect('postgres.config.plan@2', { changes })
    const planned = await w.call('POST', `/api/v1/nodes/${w.requireNode().nodeId}/plans`, {
      clusterId: w.clusterId,
      change: { kind: 'postgres.config.apply', changes, reload: true },
    })
    expect(planned.status).toBe(201)
    await w.psql(`ALTER SYSTEM SET maintenance_work_mem = '70MB'`)
    await w.psql('SELECT pg_reload_conf()')
    await w.reauth()
    const op = (await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})).body
    const stale = await w.finished(op.id)
    expect([stale.state, stale.applyOutcome, stale.errorCode]).toEqual([
      'failed',
      'not_applied',
      'PLAN_STALE',
    ])
    expect(await w.applyJobs(op.id)).toEqual([])
    expect(await w.psql('SHOW work_mem')).toBe('4MB')
    // A value ALTER SYSTEM set wins over the fragment: such a change is refused at plan time.
    await w.psql(`ALTER SYSTEM SET work_mem = '5MB'`)
    await w.psql('SELECT pg_reload_conf()')
    const changesOver = [{ name: 'work_mem', value: '9MB' }]
    await w.inspect('postgres.config.plan@2', { changes: changesOver })
    const overridden = await w.plan({
      kind: 'postgres.config.apply',
      changes: changesOver,
      reload: true,
    })
    expect([overridden.status, overridden.body?.code]).toEqual([409, 'CONFLICT'])
    expect(await w.psql('SHOW work_mem')).toBe('5MB')
    await w.psql('ALTER SYSTEM RESET work_mem')
    await w.psql('ALTER SYSTEM RESET maintenance_work_mem')
    await w.psql('SELECT pg_reload_conf()')
  })

  it('never reports a value the postmaster command line outranks as in effect (G6 A4)', async () => {
    // pg_ctlcluster passes pg_ctl_options to the postmaster: `-c` outranks every file.
    const ctl = join(dirname(w.instance.configFile), 'pg_ctl.conf')
    await writeFile(ctl, "pg_ctl_options = '-o -cwork_mem=6MB'\n")
    const [major, name] = w.instance.localName.split('/')
    await run('pg_ctlcluster', [major ?? '', name ?? '', 'restart'])
    expect(await w.psql('SHOW work_mem')).toBe('6MB')
    const changes = [{ name: 'work_mem', value: '11MB' }]
    const basis = await w.inspect('postgres.config.plan@2', { changes })
    const read = await w.sql(
      `SELECT j.completion -> 'result' -> 'parameters' -> 0 ->> 'conflict' AS conflict FROM nodes.jobs j
        WHERE j.operation_id = $1 AND j.capability = 'postgres.config.plan@2'`,
      [basis.id],
    )
    expect(read[0]?.conflict).toBe('source_overrides')
    const outranked = await w.plan({ kind: 'postgres.config.apply', changes, reload: true })
    expect([outranked.status, outranked.body?.code]).toEqual([409, 'CONFLICT'])
    expect(await w.psql('SHOW work_mem')).toBe('6MB')
    await writeFile(ctl, '')
    await run('pg_ctlcluster', [major ?? '', name ?? '', 'restart'])
  })

  it('reloads, and restarts where systemd runs the units', async () => {
    await w.inspect('postgres.status@1')
    const reload = await w.planAndApply({ kind: 'postgres.reload' })
    expect([reload.state, reload.verificationOutcome]).toEqual(['succeeded', 'passed'])
    if (SYSTEMD) {
      await w.inspect('postgres.restart.plan@2')
      const started = await w.psql('SELECT pg_postmaster_start_time()')
      const restart = await w.planAndApply({ kind: 'postgres.restart' })
      expect([restart.state, restart.verificationOutcome], await w.logs()).toEqual([
        'succeeded',
        'passed',
      ])
      expect(await w.psql('SELECT pg_postmaster_start_time()')).not.toBe(started)
    }
  })
})

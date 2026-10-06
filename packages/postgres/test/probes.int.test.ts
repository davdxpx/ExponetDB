import { dropDatabase, FaultProxy, matrix, superuserClient, testTargets } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  probeExtended,
  probeIdentity,
  probeSimple,
  readActivity,
  readCapacity,
  type TargetSession,
} from '../src/index.ts'
import { endpoint, open, prepareDatabase } from './targets.ts'

/**
 * G4 item 4, adapter side: both probe protocols reported separately (the
 * 2026-09-24 signature: simple queries pass, parameterized ones hang),
 * timeouts as `timeout`, failures with their class, the capacity
 * denominators and the activity summary's named rules on real sessions.
 */
describe.each(matrix().map((s) => [s.major, s] as const))(
  'probes on PostgreSQL %i',
  (_m, server) => {
    let db = ''
    let proxy: FaultProxy

    beforeAll(async () => {
      db = await prepareDatabase(server, `probe_${server.major}`, undefined, [
        'CREATE TABLE public.locked (id integer PRIMARY KEY)',
        'INSERT INTO public.locked VALUES (1)',
        'GRANT SELECT, UPDATE ON public.locked TO PUBLIC',
      ])
      proxy = await FaultProxy.start(testTargets(), server)
    })

    afterAll(async () => {
      await proxy.stop()
      await dropDatabase(server, db)
    })

    const viaProxy = (options = {}) =>
      open(server, db, 'observer', options, {
        endpoint: endpoint(server, { host: '127.0.0.1', port: proxy.port }),
      })

    it('passes both probes through a healthy path (TLS verified end to end)', async () => {
      proxy.setMode({ kind: 'pass' })
      const s = await viaProxy()
      try {
        expect((await probeSimple(s)).status).toBe('ok')
        expect((await probeExtended(s)).status).toBe('ok')
      } finally {
        await s.close()
      }
    })

    it('reports simple ok and extended timeout when only parameterized queries hang', async () => {
      proxy.setMode({ kind: 'pass' })
      const s = await viaProxy()
      proxy.setMode({ kind: 'hang_extended' })
      try {
        const simple = await probeSimple(s, 2000)
        const extended = await probeExtended(s, 800)
        expect(simple.status).toBe('ok')
        expect(extended.status).toBe('timeout')
        expect(s.usable).toBe(false)
      } finally {
        await s.close()
        proxy.setMode({ kind: 'pass' })
      }
    })

    it('fails an open within the connect deadline when the path hangs the extended protocol from the start', async () => {
      proxy.setMode({ kind: 'hang_extended' })
      try {
        const started = performance.now()
        await expect(viaProxy({ limits: { connectTimeoutMs: 700 } })).rejects.toMatchObject({
          code: 'TARGET_UNAVAILABLE',
          reason: 'connect_timeout',
        })
        expect(performance.now() - started).toBeLessThan(5000)
      } finally {
        proxy.setMode({ kind: 'pass' })
      }
    })

    it('opens a probe session over the simple protocol on such a path, and the probes tell it apart', async () => {
      proxy.setMode({ kind: 'hang_extended' })
      try {
        const s = await viaProxy({ guardProtocol: 'simple', limits: { connectTimeoutMs: 2000 } })
        try {
          expect(s.facts.major).toBe(server.major)
          expect((await probeSimple(s, 2000)).status).toBe('ok')
          expect((await probeExtended(s, 800)).status).toBe('timeout')
        } finally {
          await s.close()
        }
      } finally {
        proxy.setMode({ kind: 'pass' })
      }
    })

    it('reports an unreachable path as a failed connect, never as zero sessions', async () => {
      proxy.setMode({ kind: 'refuse' })
      await expect(viaProxy()).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' })
      proxy.setMode({ kind: 'blackhole' })
      await expect(viaProxy({ limits: { connectTimeoutMs: 500 } })).rejects.toMatchObject({
        code: 'TARGET_UNAVAILABLE',
      })
      proxy.setMode({ kind: 'pass' })
    })

    it('loses an established session on a network cut and says so', async () => {
      proxy.setMode({ kind: 'pass' })
      const s = await viaProxy()
      proxy.cut()
      const outcome = await probeSimple(s, 1000)
      expect(outcome.status === 'failed' || outcome.status === 'timeout').toBe(true)
      await s.close()
    })

    it('reads the identity probe as absent on an unregistered database', async () => {
      const s = await open(server, db, 'observer')
      try {
        const probe = await probeIdentity(s)
        expect(probe.outcome.status).toBe('ok')
        expect(probe.marker).toEqual({ status: 'absent' })
      } finally {
        await s.close()
      }
    })

    it('reads the capacity denominators', async () => {
      const s = await open(server, db, 'observer')
      try {
        const c = await readCapacity(s)
        expect(c.maxConnections).toBe(200)
        expect(c.usableSlots).toBe(c.maxConnections - c.superuserReserved - c.reserved)
        expect(Math.floor(c.serverVersionNum / 10000)).toBe(server.major)
      } finally {
        await s.close()
      }
    })

    it('names idle-in-transaction sessions and lock waits with the blocking pid', async () => {
      const holder = await superuserClient(server, db)
      const waiter = await superuserClient(server, db)
      let observer: TargetSession | undefined
      try {
        await holder.query("SET application_name = 'holder'")
        await holder.query('BEGIN')
        await holder.query('UPDATE public.locked SET id = id')
        await waiter.query("SET application_name = 'waiter'")
        await waiter.query('BEGIN')
        const waiting = waiter.query('UPDATE public.locked SET id = id').catch(() => undefined)
        await new Promise((r) => setTimeout(r, 11_000))
        observer = await open(server, db, 'observer')
        const a = await readActivity(observer)
        const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
        expect(a.idleInTransactionLong.some((n) => n.applicationName === 'holder')).toBe(true)
        const wait = a.lockWaits.find((n) => n.applicationName === 'waiter')
        expect(wait?.blockedBy).toContain(holderPid)
        expect(a.clientBackends).toBeGreaterThanOrEqual(2)
        expect(a.xidAge).toBeGreaterThan(0)
        await holder.query('ROLLBACK')
        await waiting
        await waiter.query('ROLLBACK')
      } finally {
        await observer?.close()
        await holder.end()
        await waiter.end()
      }
    }, 30_000)
  },
)

import { connect, type Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { LISTEN_DEADLINES, listen } from '../src/roles/lifecycle.ts'

/**
 * VC-078: the public listener had no cap on connections; a flood of unauthenticated requests
 * held about 1,700 descriptors and 143 MB. Past the cap a connection is closed at once.
 */
describe('the connection cap of a listener (VC-078)', () => {
  const open = (port: number) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => resolve(socket))
      socket.on('error', reject)
    })
  const closedWithin = (socket: Socket, ms: number) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      socket.on('close', () => {
        clearTimeout(timer)
        resolve(true)
      })
      socket.on('error', () => undefined)
    })

  it('closes the connection past the cap and keeps the ones inside it', async () => {
    const listener = await listen(
      () => new Response('ok'),
      { host: '127.0.0.1', port: 0 },
      {
        ...LISTEN_DEADLINES,
        maxConnections: 2,
      },
    )
    const sockets: Socket[] = []
    try {
      sockets.push(await open(listener.port), await open(listener.port))
      // Past the cap the server drops the connection: it never connects, or it is closed at once.
      const third = await open(listener.port).catch(() => 'refused' as const)
      if (third === 'refused') {
        expect(third).toBe('refused')
      } else {
        sockets.push(third)
        expect(await closedWithin(third, 2000)).toBe(true)
      }
      expect(sockets[0]?.destroyed).toBe(false)
      expect(sockets[1]?.destroyed).toBe(false)
    } finally {
      for (const s of sockets) s.destroy()
      await listener.close(500)
    }
  })

  it('has a cap by default', () => {
    expect(LISTEN_DEADLINES.maxConnections).toBeGreaterThan(0)
    expect(LISTEN_DEADLINES.maxConnections).toBeLessThanOrEqual(2048)
  })
})

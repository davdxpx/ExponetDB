import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { LISTEN_DEADLINES, listen } from '../src/roles/lifecycle.ts'

/**
 * The listener's read deadlines against slow clients (Wave 7 order §30) on a
 * real socket: a client that never finishes its request head, or trickles
 * its body, is cut off; a normal request is not. The deadlines are shortened
 * for the test; production uses {@link LISTEN_DEADLINES}.
 */
const SHORT = { headersMs: 400, requestMs: 800, checkMs: 100, keepAliveMs: 200 }

/** Writes `chunks` (one per `gapMs`) and resolves with what came back and when the socket closed. */
function slowClient(
  port: number,
  chunks: readonly string[],
  gapMs: number,
): Promise<{ received: string; closedAfterMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const socket = connect(port, '127.0.0.1')
    let received = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    socket.on('data', (d) => {
      received += d.toString('latin1')
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearTimeout(timer)
      resolve({ received, closedAfterMs: Date.now() - started })
    })
    socket.on('connect', () => {
      let i = 0
      const next = () => {
        const chunk = chunks[i]
        if (chunk === undefined || socket.destroyed) return
        socket.write(chunk)
        i += 1
        timer = setTimeout(next, gapMs)
      }
      next()
    })
    setTimeout(() => {
      socket.destroy()
      reject(new Error('the server kept the slow connection open'))
    }, 10_000).unref()
  })
}

describe('listener read deadlines (slow clients)', () => {
  it('keeps the production deadlines ordered and bounded', () => {
    expect(LISTEN_DEADLINES.headersMs).toBeLessThanOrEqual(LISTEN_DEADLINES.requestMs)
    expect(LISTEN_DEADLINES.headersMs).toBeLessThanOrEqual(30_000)
    expect(LISTEN_DEADLINES.requestMs).toBeLessThanOrEqual(300_000)
    expect(LISTEN_DEADLINES.checkMs).toBeLessThan(LISTEN_DEADLINES.headersMs)
  })

  it('cuts off a request head that never completes, and one whose body trickles', async () => {
    let served = 0
    const listener = await listen(
      async (request) => {
        // Reads the whole body, as a real route does: only a deadline ends a trickle.
        await request.text()
        served += 1
        return new Response('ok')
      },
      { host: '127.0.0.1', port: 0 },
      SHORT,
    )
    try {
      // Slowloris: a header line every 150 ms, never the blank line that ends the head.
      const head = await slowClient(
        listener.port,
        [
          'POST /mcp HTTP/1.1\r\n',
          'Host: x\r\n',
          ...Array.from({ length: 40 }, (_, i) => `X-${i}: y\r\n`),
        ],
        150,
      )
      expect(head.received).toMatch(/^HTTP\/1\.1 408/)
      expect(head.closedAfterMs).toBeLessThan(3_000)
      // A complete head, then a body one byte per 150 ms that never reaches its length.
      const body = await slowClient(
        listener.port,
        [
          'POST /api/v1/x HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n',
          ...Array.from({ length: 60 }, () => 'a'),
        ],
        150,
      )
      expect(body.received).toMatch(/^HTTP\/1\.1 408/)
      expect(body.closedAfterMs).toBeLessThan(4_000)
      expect(served).toBe(0)
      // A normal request is served.
      const res = await fetch(`http://127.0.0.1:${listener.port}/`, { method: 'POST', body: 'x' })
      expect(await res.text()).toBe('ok')
      expect(served).toBe(1)
    } finally {
      await listener.close(1_000)
    }
  }, 30_000)

  it('negative control: with long deadlines the same slow head is still open after 2 s', async () => {
    // Shows that the cut-off above comes from the deadlines, not from the client or the socket.
    const listener = await listen(
      async () => new Response('ok'),
      { host: '127.0.0.1', port: 0 },
      { headersMs: 20_000, requestMs: 30_000, checkMs: 100, keepAliveMs: 200 },
    )
    try {
      const state = await new Promise<{ received: string; closed: boolean }>((resolve) => {
        const socket = connect(listener.port, '127.0.0.1')
        let received = ''
        let closed = false
        socket.on('data', (d) => {
          received += d.toString('latin1')
        })
        socket.on('error', () => undefined)
        socket.on('close', () => {
          closed = true
        })
        const lines = ['POST /mcp HTTP/1.1\r\n', 'Host: x\r\n']
        let i = 0
        const writer = setInterval(() => {
          if (!socket.destroyed) socket.write(lines[i] ?? `X-${i}: y\r\n`)
          i += 1
        }, 150)
        setTimeout(() => {
          clearInterval(writer)
          resolve({ received, closed })
          socket.destroy()
        }, 2_000)
      })
      expect(state).toEqual({ received: '', closed: false })
    } finally {
      await listener.close(1_000)
    }
  }, 30_000)
})

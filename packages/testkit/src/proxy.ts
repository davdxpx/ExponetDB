import { createServer, type Server, type Socket, connect as tcpConnect } from 'node:net'
import { TLSSocket, connect as tlsConnect } from 'node:tls'
import type { TestServer, TestTargets } from './servers.ts'

/**
 * A fault-injecting PostgreSQL proxy for the tests ([postgres-adapter.md §9](../../../exponetdb-docs/03-database-model/postgres-adapter.md#9-testing-support),
 * [health.md §2](../../../exponetdb-docs/10-observability/health.md#2-probes)).
 *
 * It speaks the protocol's TLS negotiation on both sides: it terminates the
 * client's TLS with the run's server certificate (so `verify-full` against the
 * run's CA still passes) and opens its own verified TLS connection to the
 * real server. In between it sees protocol messages and can:
 *
 * - `pass`: forward everything;
 * - `refuse`: close new connections at once;
 * - `blackhole`: accept and never answer (a hung connect);
 * - `hang_extended`: forward until the client sends `Parse` (extended
 *   protocol), then forward nothing more from that client: simple queries
 *   work, parameterized ones hang (the 2026-09-24 pooler signature);
 * - `delay`: add latency to every chunk;
 * - `cut()`: drop every open connection.
 */
export type ProxyMode =
  | { readonly kind: 'pass' }
  | { readonly kind: 'refuse' }
  | { readonly kind: 'blackhole' }
  | { readonly kind: 'hang_extended' }
  | { readonly kind: 'delay'; readonly ms: number }

const SSL_REQUEST = 80877103

export class FaultProxy {
  readonly #server: Server
  readonly #upstream: TestServer
  readonly #targets: TestTargets
  readonly #sockets = new Set<Socket>()
  #mode: ProxyMode = { kind: 'pass' }
  #accepted = 0
  #port = 0

  private constructor(targets: TestTargets, upstream: TestServer) {
    this.#targets = targets
    this.#upstream = upstream
    this.#server = createServer((socket) => this.#accept(socket))
  }

  static async start(targets: TestTargets, upstream: TestServer): Promise<FaultProxy> {
    const proxy = new FaultProxy(targets, upstream)
    await new Promise<void>((resolve) => proxy.#server.listen(0, '127.0.0.1', resolve))
    const address = proxy.#server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('proxy did not bind')
    }
    proxy.#port = address.port
    return proxy
  }

  get port(): number {
    return this.#port
  }

  /** Connections accepted since start (including refused ones). */
  get accepted(): number {
    return this.#accepted
  }

  get open(): number {
    return this.#sockets.size
  }

  setMode(mode: ProxyMode): void {
    this.#mode = mode
  }

  /** Drops every open connection (a network cut). */
  cut(): void {
    for (const s of this.#sockets) {
      s.destroy()
    }
    this.#sockets.clear()
  }

  async stop(): Promise<void> {
    this.cut()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  #track(socket: Socket): void {
    this.#sockets.add(socket)
    socket.on('close', () => this.#sockets.delete(socket))
    socket.on('error', () => socket.destroy())
  }

  #accept(client: Socket): void {
    this.#accepted++
    this.#track(client)
    const mode = this.#mode
    if (mode.kind === 'refuse') {
      client.destroy()
      return
    }
    if (mode.kind === 'blackhole') {
      return
    }
    client.once('data', (first) => {
      if (first.length < 8 || first.readInt32BE(4) !== SSL_REQUEST) {
        client.destroy()
        return
      }
      client.write('S')
      const secure = new TLSSocket(client, {
        isServer: true,
        cert: this.#targets.serverCertPem,
        key: this.#targets.serverKeyPem,
      })
      this.#track(secure)
      void this.#bridge(secure)
    })
  }

  async #bridge(client: TLSSocket): Promise<void> {
    let upstream: TLSSocket
    try {
      upstream = await this.#openUpstream()
    } catch {
      client.destroy()
      return
    }
    this.#track(upstream)
    const delay = () => (this.#mode.kind === 'delay' ? this.#mode.ms : 0)
    const send = (target: TLSSocket, chunk: Buffer) => {
      const ms = delay()
      if (ms > 0) setTimeout(() => target.write(chunk), ms)
      else target.write(chunk)
    }
    upstream.on('data', (chunk: Buffer) => send(client, chunk))
    upstream.on('close', () => client.destroy())
    client.on('close', () => upstream.destroy())
    // Client → server: frame messages after the startup packet to see `Parse`.
    let started = false
    let hung = false
    let buffer = Buffer.alloc(0)
    client.on('data', (chunk: Buffer) => {
      if (hung) return
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (!started) {
          if (buffer.length < 4) return
          const len = buffer.readInt32BE(0)
          if (buffer.length < len) return
          send(upstream, buffer.subarray(0, len))
          buffer = buffer.subarray(len)
          started = true
          continue
        }
        if (buffer.length < 5) return
        const type = String.fromCharCode(buffer[0] ?? 0)
        const len = buffer.readInt32BE(1) + 1
        if (buffer.length < len) return
        if (type === 'P' && this.#mode.kind === 'hang_extended') {
          hung = true
          return
        }
        send(upstream, buffer.subarray(0, len))
        buffer = buffer.subarray(len)
      }
    })
  }

  #openUpstream(): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      const raw = tcpConnect(this.#upstream.port, this.#upstream.host)
      raw.once('error', reject)
      raw.once('connect', () => {
        const request = Buffer.alloc(8)
        request.writeInt32BE(8, 0)
        request.writeInt32BE(SSL_REQUEST, 4)
        raw.write(request)
        raw.once('data', (answer) => {
          if (answer.toString('latin1', 0, 1) !== 'S') {
            raw.destroy()
            reject(new Error('upstream refused TLS'))
            return
          }
          const secure = tlsConnect({
            socket: raw,
            ca: this.#targets.caPem,
            servername: this.#targets.serverName,
            rejectUnauthorized: true,
          })
          secure.once('secureConnect', () => resolve(secure))
          secure.once('error', reject)
        })
      })
    })
  }
}

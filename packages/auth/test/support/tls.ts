import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { oauth } from '../../src/index.ts'

/**
 * A throwaway TLS world for the metadata fetcher: a test CA and a server
 * certificate for synthetic names, generated with OpenSSL at test time
 * (no key material is committed), and an HTTPS server on 127.0.0.1. The
 * fetcher's network is the production one with two substitutions: the
 * resolver answers a fixed public address, and the connection to that
 * pinned address is redirected to the local server. Certificate and host
 * name verification, the address policy and every limit stay real.
 */
export interface TlsWorld {
  readonly ca: string
  readonly port: number
  /** The pinned addresses the fetcher connected to. */
  readonly connections: string[]
  /**
   * The fetcher's network; `untrusted` sends the connection to a server whose
   * certificate comes from a CA the fetcher does not trust.
   */
  network(
    answers?: Record<string, readonly string[]>,
    options?: { readonly untrusted?: boolean },
  ): oauth.FetchNetwork
  setHandler(handler: (req: IncomingMessage, res: ServerResponse) => void): void
  close(): Promise<void>
}

/** A globally reachable address (AS112 anycast); never contacted: the test redirects the connection. */
export const PUBLIC_ADDRESS = '192.175.48.1'

function openssl(dir: string, args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
}

function certificates(dir: string, prefix: string, names: readonly string[]) {
  openssl(dir, [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    `${prefix}-ca.key`,
    '-out',
    `${prefix}-ca.crt`,
    '-days',
    '1',
    '-subj',
    `/CN=ExponetDB ${prefix} test CA`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign',
  ])
  openssl(dir, [
    'req',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    `${prefix}-leaf.key`,
    '-out',
    `${prefix}-leaf.csr`,
    '-subj',
    `/CN=${names[0]}`,
  ])
  writeFileSync(
    join(dir, `${prefix}-ext.cnf`),
    `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')}\nextendedKeyUsage=serverAuth\n`,
  )
  openssl(dir, [
    'x509',
    '-req',
    '-in',
    `${prefix}-leaf.csr`,
    '-CA',
    `${prefix}-ca.crt`,
    '-CAkey',
    `${prefix}-ca.key`,
    '-CAcreateserial',
    '-out',
    `${prefix}-leaf.crt`,
    '-days',
    '1',
    '-extfile',
    `${prefix}-ext.cnf`,
  ])
  return {
    ca: readFileSync(join(dir, `${prefix}-ca.crt`), 'utf8'),
    key: readFileSync(join(dir, `${prefix}-leaf.key`), 'utf8'),
    cert: readFileSync(join(dir, `${prefix}-leaf.crt`), 'utf8'),
  }
}

export async function tlsWorld(names: readonly string[]): Promise<TlsWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'exdb-tls-'))
  const trusted = certificates(dir, 'trusted', names)
  const untrusted = certificates(dir, 'untrusted', names)
  rmSync(dir, { recursive: true, force: true })
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.statusCode = 404
    res.end()
  }
  const server = createServer({ key: trusted.key, cert: trusted.cert }, (req, res) =>
    handler(req, res),
  )
  const impostor = createServer({ key: untrusted.key, cert: untrusted.cert }, (_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => impostor.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const impostorPort = (impostor.address() as AddressInfo).port
  const connections: string[] = []
  return {
    ca: trusted.ca,
    port,
    connections,
    network(answers = {}, options = {}) {
      const real = oauth.systemNetwork({
        ca: trusted.ca,
        port: options.untrusted === true ? impostorPort : port,
      })
      return {
        async resolve(hostname) {
          const list = answers[hostname] ?? [PUBLIC_ADDRESS]
          return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
        },
        connect(target) {
          connections.push(target.address)
          return real.connect({ ...target, address: '127.0.0.1' })
        },
      }
    },
    setHandler(next) {
      handler = next
    },
    close: async () => {
      for (const s of [server, impostor]) {
        s.closeAllConnections()
        await new Promise<void>((resolve) => s.close(() => resolve()))
      }
    },
  }
}

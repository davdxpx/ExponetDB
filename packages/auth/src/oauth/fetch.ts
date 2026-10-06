import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { BlockList, isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import { OAUTH_LIMITS } from '@exponetdb/contracts'

/**
 * The hardened fetcher of Client ID Metadata Documents (oauth.md §7). It is
 * not a general HTTP client and never uses `fetch(url)`:
 *
 * - the URL is an exact `https` URL with a DNS host name (no IP literal),
 *   the default port, a path, and no user information, query or fragment;
 * - the name is resolved **once**; every resolved address must be a public
 *   unicast address (loopback, private, CGNAT, link-local and cloud
 *   metadata, multicast, reserved, documentation, NAT64/6to4/Teredo and
 *   IPv6 unique-local ranges refused; an IPv4-mapped IPv6 address is judged
 *   as its IPv4 address). If any address is refused, the fetch is refused,
 *   so a round-robin answer cannot smuggle an internal address;
 * - the connection goes to that pinned address (no second resolution, so a
 *   DNS rebinding between check and use is impossible), through no proxy
 *   (no agent, no environment proxy), with TLS 1.2+ whose certificate must
 *   be valid for the host name (SNI and verification use the name);
 * - one `GET`, no redirect followed (any 3xx is refused), no compression,
 *   status 200, `Content-Type: application/json`, at most 64 KiB counted as
 *   the bytes arrive, the whole exchange bounded by 5 seconds.
 *
 * The network is a port so tests can redirect the pinned connection to a
 * local TLS server; the address policy and every other check always apply.
 */
export interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

export interface FetchNetwork {
  resolve(hostname: string): Promise<readonly ResolvedAddress[]>
  /** A TLS connection to exactly this address, verified for `servername`. */
  connect(target: {
    readonly address: string
    readonly family: 4 | 6
    readonly port: number
    readonly servername: string
  }): Duplex
}

export type FetchRefusal =
  | 'url_invalid'
  | 'address_refused'
  | 'dns_failed'
  | 'tls_failed'
  | 'timeout'
  | 'redirect_refused'
  | 'status_refused'
  | 'content_type_refused'
  | 'encoding_refused'
  | 'too_large'
  | 'network_failed'

export class MetadataFetchError extends Error {
  override readonly name = 'MetadataFetchError'
  readonly reason: FetchRefusal
  constructor(reason: FetchRefusal) {
    super(reason)
    this.reason = reason
  }
}

export interface FetchedDocument {
  readonly text: string
  /** `Cache-Control: max-age` in seconds, when the server sent one. */
  readonly maxAgeSeconds: number | undefined
  /** The pinned address the document came from (for tests and diagnostics only). */
  readonly address: string
}

// ----- the address policy -----

// Two lists: Node's BlockList also matches IPv4 addresses against IPv4-mapped
// IPv6 rules, so the families are kept apart (mapped addresses are judged as
// their IPv4 address below).
const BLOCKED_V4 = new BlockList()
const BLOCKED_V6 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (CGNAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments (incl. NAT64 discovery)
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments (Teredo, ORCHID, …)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['5f00::', 16], // segment routing
  ['fc00::', 7], // unique local (incl. cloud metadata fd00:ec2::254)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6')
}

/** Whether ExponetDB may connect to this address to fetch client metadata. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 0) {
    return false
  }
  if (version === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
    if (mapped?.[1] !== undefined) {
      return isPublicAddress(mapped[1])
    }
    // Only global unicast (2000::/3) is public at all.
    if (!/^[23][0-9a-f]{3}:/i.test(address)) {
      return false
    }
    return !BLOCKED_V6.check(address, 'ipv6')
  }
  return !BLOCKED_V4.check(address, 'ipv4')
}

// ----- the URL -----

const DNS_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * A client metadata URL ExponetDB fetches: `https`, a DNS name with at least
 * one dot (no IP literal, no `localhost`), the default port, a path other
 * than `/` without dot segments, no user information, query or fragment,
 * at most 512 characters, already in its canonical spelling.
 */
export function parseMetadataUrl(value: string): URL | undefined {
  if (value.length > OAUTH_LIMITS.maxRedirectUriLength || /[\s\p{Cc}]/u.test(value)) {
    return undefined
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (
    url.href !== value ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    value.includes('?') ||
    value.includes('#') ||
    url.pathname === '/' ||
    /\/\.{1,2}(\/|$)/.test(url.pathname) ||
    !DNS_NAME.test(url.hostname) ||
    isIP(url.hostname) !== 0 ||
    !/[a-z]/.test(url.hostname.slice(url.hostname.lastIndexOf('.') + 1)) ||
    url.hostname.endsWith('.localhost') ||
    url.hostname.endsWith('.local') ||
    url.hostname.endsWith('.internal')
  ) {
    return undefined
  }
  return url
}

// ----- the network -----

/** The production network: the system resolver and a direct TLS connection. */
export function systemNetwork(
  options: { readonly ca?: string | Buffer; readonly port?: number } = {},
): FetchNetwork {
  return {
    async resolve(hostname) {
      const answers = await lookup(hostname, { all: true, verbatim: true })
      return answers
        .filter((a) => a.family === 4 || a.family === 6)
        .map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))
    },
    connect(target) {
      return tlsConnect({
        host: target.address,
        port: options.port ?? target.port,
        servername: target.servername,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        ALPNProtocols: ['http/1.1'],
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      })
    },
  }
}

function maxAge(header: string | undefined): number | undefined {
  const match = /(?:^|,)\s*max-age\s*=\s*(\d{1,9})\s*(?:,|$)/i.exec(header ?? '')
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/** Fetches a metadata document under every rule above; throws `MetadataFetchError`. */
export async function fetchMetadataDocument(
  value: string,
  network: FetchNetwork,
  options: { readonly timeoutMs?: number; readonly maxBytes?: number } = {},
): Promise<FetchedDocument> {
  const url = parseMetadataUrl(value)
  if (url === undefined) {
    throw new MetadataFetchError('url_invalid')
  }
  const timeoutMs = options.timeoutMs ?? OAUTH_LIMITS.cimdTimeoutMs
  const maxBytes = options.maxBytes ?? OAUTH_LIMITS.cimdMaxBytes
  const deadline = Date.now() + timeoutMs
  let addresses: readonly ResolvedAddress[]
  try {
    addresses = await withTimeout(network.resolve(url.hostname), timeoutMs)
  } catch (error) {
    throw error instanceof MetadataFetchError ? error : new MetadataFetchError('dns_failed')
  }
  if (addresses.length === 0) {
    throw new MetadataFetchError('dns_failed')
  }
  if (!addresses.every((a) => isPublicAddress(a.address))) {
    throw new MetadataFetchError('address_refused')
  }
  const pinned = addresses[0]
  if (pinned === undefined) {
    throw new MetadataFetchError('dns_failed')
  }
  return new Promise<FetchedDocument>((resolve, reject) => {
    let settled = false
    const fail = (reason: FetchRefusal) => {
      if (!settled) {
        settled = true
        socket.destroy()
        reject(new MetadataFetchError(reason))
      }
    }
    const timer = setTimeout(() => fail('timeout'), Math.max(1, deadline - Date.now()))
    timer.unref()
    const socket = network.connect({
      address: pinned.address,
      family: pinned.family,
      port: 443,
      servername: url.hostname,
    })
    socket.on('error', (error: Error & { code?: unknown }) => {
      const code = typeof error.code === 'string' ? error.code : ''
      fail(
        /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO|HOSTNAME|ALTNAME/i.test(code)
          ? 'tls_failed'
          : 'network_failed',
      )
    })
    const req = httpRequest({
      createConnection: () => socket,
      method: 'GET',
      path: url.pathname,
      setHost: false,
      headers: {
        host: url.hostname,
        accept: 'application/json',
        'accept-encoding': 'identity',
        'user-agent': 'ExponetDB-CIMD/1',
        connection: 'close',
      },
    })
    req.on('error', (error: Error & { code?: unknown }) => {
      const code = typeof error.code === 'string' ? error.code : ''
      fail(
        /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO|HOSTNAME|ALTNAME/i.test(code)
          ? 'tls_failed'
          : 'network_failed',
      )
    })
    req.on('response', (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) {
        res.resume()
        fail('redirect_refused')
        return
      }
      if (status !== 200) {
        res.resume()
        fail('status_refused')
        return
      }
      const type = (res.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
      if (type !== 'application/json') {
        res.resume()
        fail('content_type_refused')
        return
      }
      const encoding = res.headers['content-encoding']
      if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
        res.resume()
        fail('encoding_refused')
        return
      }
      const declared = res.headers['content-length']
      if (declared !== undefined && (!/^\d{1,12}$/.test(declared) || Number(declared) > maxBytes)) {
        res.resume()
        fail('too_large')
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          fail('too_large')
          return
        }
        chunks.push(chunk)
      })
      res.on('error', () => fail('network_failed'))
      res.on('end', () => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        socket.destroy()
        let text: string
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
        } catch {
          reject(new MetadataFetchError('content_type_refused'))
          return
        }
        resolve({
          text,
          maxAgeSeconds: maxAge(res.headers['cache-control']),
          address: pinned.address,
        })
      })
    })
    req.end()
  })
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MetadataFetchError('timeout')), ms)
    timer.unref()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

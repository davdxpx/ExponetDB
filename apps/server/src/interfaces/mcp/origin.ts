/**
 * Who may call `/mcp` from a browser context, and under which host name
 * (ADR-0027 §3, protocol-baseline.md M-15). The allowlist comes from the
 * configuration only, never from the request: the origin of
 * `EXPONETDB_PUBLIC_URL`, the configured extra origins, and, when the public
 * URL is a loopback address (the local lab), the loopback names on the
 * same port. Comparison is exact; `null` is never allowed. A request
 * without `Origin` (a native client) passes this check and still needs a
 * token.
 */
export interface OriginPolicy {
  readonly origins: ReadonlySet<string>
  readonly hosts: ReadonlySet<string>
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

function isLoopback(hostname: string): boolean {
  return LOOPBACK.includes(hostname.toLowerCase())
}

export function originPolicy(publicUrl: string, extraOrigins: readonly string[]): OriginPolicy {
  const url = new URL(publicUrl)
  const origins = new Set<string>([url.origin])
  const hosts = new Set<string>([url.host.toLowerCase()])
  const defaultPort = url.protocol === 'https:' ? '443' : '80'
  if (isLoopback(url.hostname)) {
    const port = url.port === '' ? defaultPort : url.port
    for (const name of LOOPBACK) {
      origins.add(`${url.protocol}//${name}${port === defaultPort ? '' : `:${port}`}`)
      hosts.add(port === defaultPort ? name : `${name}:${port}`)
    }
  }
  for (const extra of extraOrigins) {
    origins.add(new URL(extra).origin)
  }
  return { origins, hosts }
}

/** `undefined` when allowed (absent or listed); otherwise the refusal reason. */
export function checkOrigin(
  policy: OriginPolicy,
  origin: string | undefined,
): 'origin' | undefined {
  if (origin === undefined) {
    return undefined
  }
  return policy.origins.has(origin) ? undefined : 'origin'
}

export function checkHost(policy: OriginPolicy, host: string | undefined): 'host' | undefined {
  if (host === undefined) {
    return 'host'
  }
  return policy.hosts.has(host.toLowerCase()) ? undefined : 'host'
}

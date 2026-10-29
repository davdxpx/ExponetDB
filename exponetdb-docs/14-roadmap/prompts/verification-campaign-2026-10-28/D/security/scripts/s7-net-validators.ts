// S7 task 1: the CIMD fetcher's validators as pure functions, and the fetcher against a local TLS world.
// Run on the server (Bun 1.4.4):  cd /srv/work/s1/src/packages/auth && bun run /srv/work/s7/s7-net-validators.ts
// Imports the product's sources and the product's own TLS test support read-only; writes nothing in the tree.
// Output: one line per case, "PASS|FAIL|NOTE id: expected -> actual". No secret, no network beyond 127.0.0.1.
import { oauth } from '/srv/work/s1/src/packages/auth/src/index.ts'
import { tlsWorld, PUBLIC_ADDRESS } from '/srv/work/s1/src/packages/auth/test/support/tls.ts'

let fails = 0
let n = 0
function check(id: string, expected: unknown, actual: unknown, note = ''): void {
  n++
  const ok = JSON.stringify(expected) === JSON.stringify(actual)
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: expected ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}${note ? ` (${note})` : ''}`)
}
function note(id: string, text: string): void {
  console.log(`NOTE ${id}: ${text}`)
}

// ---------------------------------------------------------------------------------------------------
// A. The address policy (isPublicAddress): what the fetcher may connect to AFTER resolution. Every form of every non-public range.
// ---------------------------------------------------------------------------------------------------
console.log('## A. isPublicAddress (post-resolution address policy)')
const refusedAddresses: [string, string][] = [
  ['127.0.0.1', 'loopback'], ['127.1', 'short loopback (not an IP literal)'], ['2130706433', 'decimal loopback'],
  ['0x7f000001', 'hex loopback'], ['0177.0.0.1', 'octal loopback'], ['127.255.255.254', 'loopback range end'],
  ['::1', 'IPv6 loopback'], ['[::1]', 'bracketed IPv6 loopback'], ['::', 'unspecified'], ['0.0.0.0', 'this network'],
  ['::ffff:127.0.0.1', 'v4-mapped loopback (dotted)'], ['::ffff:7f00:1', 'v4-mapped loopback (hex)'],
  ['0:0:0:0:0:ffff:7f00:1', 'v4-mapped loopback (expanded)'], ['0:0:0:0:0:ffff:127.0.0.1', 'v4-mapped (expanded, dotted)'],
  ['::ffff:169.254.169.254', 'v4-mapped metadata'], ['::ffff:10.0.0.1', 'v4-mapped private'], ['::127.0.0.1', 'v4-compatible loopback'],
  ['::ffff:0:127.0.0.1', 'SIIT-translated loopback'], ['64:ff9b::7f00:1', 'NAT64 of loopback'], ['64:ff9b::a9fe:a9fe', 'NAT64 of metadata'],
  ['2002:7f00:1::', '6to4 of loopback'], ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'],
  ['169.254.169.254', 'cloud metadata'], ['169.254.0.1', 'link-local'], ['100.64.0.1', 'CGNAT start'], ['100.127.255.254', 'CGNAT end'],
  ['10.0.0.1', '10/8'], ['10.255.255.255', '10/8 end'], ['172.16.0.1', '172.16/12'], ['172.31.255.255', '172.16/12 end'],
  ['192.168.0.1', '192.168/16'], ['192.168.255.255', '192.168/16 end'], ['192.0.0.192', 'IETF protocol assignment'],
  ['198.18.0.1', 'benchmarking'], ['198.19.255.255', 'benchmarking end'], ['192.0.2.1', 'doc'], ['198.51.100.1', 'doc'], ['203.0.113.1', 'doc'],
  ['192.88.99.1', '6to4 relay'], ['224.0.0.1', 'multicast'], ['239.255.255.255', 'multicast end'], ['240.0.0.1', 'reserved'], ['255.255.255.255', 'broadcast'],
  ['fc00::1', 'ULA'], ['fd00::1', 'ULA'], ['fd00:ec2::254', 'AWS metadata v6'], ['fdff:ffff::1', 'ULA end'],
  ['fe80::1', 'link-local'], ['fe80::1%eth0', 'link-local with zone id'], ['febf::1', 'link-local end'], ['fec0::1', 'site-local'],
  ['ff02::1', 'multicast'], ['100::1', 'discard'], ['2001:db8::1', 'doc'], ['3fff::1', 'doc'], ['5f00::1', 'SRv6'],
  ['', 'empty'], ['localhost', 'name'], ['example.com', 'name'], ['1.2.3', 'short dotted'], ['1.2.3.4.5', 'five groups'], ['1.2.3.256', 'octet out of range'],
  ['8.8.8.8 ', 'trailing space'], [' 8.8.8.8', 'leading space'], ['8.8.8.8\n', 'newline'], ['0:0:0:0:0:0:0:1', 'expanded ::1'], ['::0001', '::1 leading zeros'],
]
for (const [a, why] of refusedAddresses) check(`addr refuse ${JSON.stringify(a)} (${why})`, false, oauth.isPublicAddress(a))
const acceptedAddresses: [string, string][] = [
  ['8.8.8.8', 'public'], ['1.1.1.1', 'public'], ['172.32.0.1', 'just above 172.16/12'], ['172.15.255.255', 'just below 172.16/12'],
  ['100.128.0.1', 'just above CGNAT'], ['100.63.255.255', 'just below CGNAT'], ['169.253.255.255', 'just below link-local'],
  ['192.169.0.1', 'just above 192.168/16'], ['198.20.0.1', 'just above benchmarking'], ['223.255.255.254', 'last unicast'],
  ['2606:4700:4700::1111', 'public v6'], ['2606:4700:4700:0:0:0:0:1111', 'public v6 expanded'], ['2A00:1450:4001::1', 'public v6 upper case'],
  ['::ffff:8.8.8.8', 'v4-mapped public (judged as its v4)'], ['2001:200::1', 'above 2001::/23 (APNIC)'], ['3ffe::1', '2000::/3, not documentation (3fff::/20)'],
]
for (const [a, why] of acceptedAddresses) check(`addr accept ${JSON.stringify(a)} (${why})`, true, oauth.isPublicAddress(a))

// ---------------------------------------------------------------------------------------------------
// B. The URL (parseMetadataUrl): what a CIMD client_id may look like BEFORE any resolution.
// ---------------------------------------------------------------------------------------------------
console.log('## B. parseMetadataUrl (client_id URL)')
const okUrl = (u: string) => oauth.parseMetadataUrl(u) !== undefined
const urlRefuse: [string, string][] = [
  ['http://client.example.com/c.json', 'http scheme'], ['HTTPS://client.example.com/c.json', 'upper-case scheme'], ['ftp://client.example.com/c.json', 'ftp'],
  ['file:///etc/passwd', 'file'], ['gopher://client.example.com/', 'gopher'], ['//client.example.com/c.json', 'scheme-relative'], ['client.example.com/c.json', 'no scheme'],
  ['https://127.0.0.1/c.json', 'loopback literal'], ['https://127.1/c.json', 'short loopback'], ['https://2130706433/c.json', 'decimal loopback'],
  ['https://0x7f000001/c.json', 'hex loopback'], ['https://0177.0.0.1/c.json', 'octal loopback'], ['https://[::1]/c.json', 'IPv6 loopback'],
  ['https://[::ffff:127.0.0.1]/c.json', 'v4-mapped'], ['https://[::ffff:7f00:1]/c.json', 'v4-mapped hex'], ['https://169.254.169.254/latest/meta-data', 'metadata literal'],
  ['https://[fd00:ec2::254]/c.json', 'metadata v6'], ['https://100.64.0.1/c.json', 'CGNAT'], ['https://10.0.0.1/c.json', '10/8'], ['https://172.16.0.1/c.json', '172.16/12'],
  ['https://192.168.0.1/c.json', '192.168/16'], ['https://[fc00::1]/c.json', 'ULA'], ['https://[fe80::1]/c.json', 'link-local'], ['https://8.8.8.8/c.json', 'ANY ip literal, even public'],
  ['https://localhost/c.json', 'localhost'], ['https://localhost./c.json', 'localhost with trailing dot'], ['https://LOCALHOST/c.json', 'upper-case localhost'],
  ['https://client.localhost/c.json', '.localhost'], ['https://client.local/c.json', '.local'], ['https://client.internal/c.json', '.internal'],
  ['https://metadata.google.internal/c.json', 'GCP metadata name'], ['https://client.example.com./c.json', 'trailing-dot FQDN'],
  ['https://user@client.example.com/c.json', 'userinfo'], ['https://user:pw@client.example.com/c.json', 'userinfo with password'], ['https://client.example.com@evil.example.org/c.json', 'userinfo that looks like a host'],
  ['https://client.example.com:443/c.json', 'explicit default port'], ['https://client.example.com:8443/c.json', 'other port'], ['https://client.example.com:80/c.json', 'port 80'],
  ['https://client.example.com/', 'path "/" only'], ['https://client.example.com', 'no path'], ['https://client.example.com/c.json?x=1', 'query'], ['https://client.example.com/c.json?', 'empty query'],
  ['https://client.example.com/c.json#f', 'fragment'], ['https://client.example.com/c.json#', 'empty fragment'], ['https://client.example.com/a/../c.json', 'dot-dot'], ['https://client.example.com/./c.json', 'dot'],
  ['https://client.example.com/%2e%2e/c.json', 'encoded dot-dot'], ['https://client.example.com/%2E/c.json', 'encoded dot'], ['https://client.example.com/a b.json', 'space'],
  ['https://client.example.com/a\tb.json', 'tab'], ['https://client.example.com/c.json\n', 'trailing newline'], ['https://client.example.com/\u0000', 'NUL'], ['https://client.example.com/a\\b', 'backslash'],
  ['https://CLIENT.example.com/c.json', 'upper-case host (not canonical)'], ['https://clïent.example.com/c.json', 'IDN host in Unicode'], ['https://еxample.com/c.json', 'Cyrillic e lookalike'],
  ['https://a.b.c.d.5/c.json', 'numeric last label'], ['https://1.2.3.4.5/c.json', 'five numeric groups'],
  ['https://client_underscore.example.com/c.json', 'underscore in host'], ['https://-client.example.com/c.json', 'leading hyphen'], ['https://client.example.com../c.json', 'double dot'],
  ['https://.example.com/c.json', 'empty first label'], ['https://example/c.json', 'single label'], ['https://' + 'a'.repeat(64) + '.example.com/c.json', '64-char label'],
  ['https://client.example.com/' + 'a'.repeat(600), 'over 512 characters'],
]
for (const [u, why] of urlRefuse) check(`url refuse ${JSON.stringify(u.slice(0, 70))} (${why})`, false, okUrl(u))
const urlAccept: [string, string][] = [
  ['https://client.example.com/c.json', 'plain'], ['https://client.example.com/a/b/c.json', 'deep path'], ['https://xn--clnt-0ra.example.com/c.json', 'punycode host (A-label)'],
  ['https://client.example.com/c.json/', 'trailing slash'], ['https://client.example.com/%7Efoo', 'percent-encoded unreserved character: WHATWG keeps it verbatim, so href equals the value; harmless in a path (my first expectation "refused" was wrong)'], ['https://a.example.test/c', 'a .test name (resolution decides)'], ['https://client.example.com/%E2%9C%93', 'percent-encoded UTF-8 path'],
  ['https://127.0.0.1.nip.io/c.json', 'a NAME that resolves to loopback (stopped only by the address check)'],
  ['https://localtest.me/c.json', 'a public name that resolves to loopback (stopped only by the address check)'],
]
for (const [u, why] of urlAccept) check(`url accept ${JSON.stringify(u.slice(0, 70))} (${why})`, true, okUrl(u))

// ---------------------------------------------------------------------------------------------------
// C. The media type
// ---------------------------------------------------------------------------------------------------
console.log('## C. isJsonMediaType')
const mt: [string | undefined, boolean][] = [
  ['application/json', true], ['Application/JSON', true], ['application/json; charset=utf-8', true], ['application/json;charset="UTF-8"', true], ['application/vnd.example+json', true],
  ['application/json; charset=utf-16', false], ['application/json; charset=latin1', false], ['text/json', false], ['text/plain', false], ['text/html', false], ['application/javascript', false],
  ['application/json.evil', false], ['application/x+json.evil', false], ['application/+json', false], ['application/jsonp', false], ['application/json, text/html', false], ['application/json;', true],
  ['application/ json', false], ['application /json', false], ['', false], [undefined, false], ['application/json; charset=utf-8; boundary=x', true], ['multipart/form-data; x=application/json', false],
  ['application/json\u0000', false], ['application/json x', false],
]
for (const [v, want] of mt) check(`mediatype ${JSON.stringify(v)}`, want, oauth.isJsonMediaType(v))

// ---------------------------------------------------------------------------------------------------
// D. The fetcher against a local TLS world: resolution, pinning, redirects, limits.
// ---------------------------------------------------------------------------------------------------
console.log('## D. fetchMetadataDocument (local TLS world; resolver and connect are the product port, the address policy and every limit are real)')
const HOST = 'client.example.test'
const URL_OK = `https://${HOST}/oauth/client.json`
const doc = (id = URL_OK) => JSON.stringify({ client_id: id, client_name: 'S7 probe', redirect_uris: ['https://client.example.test/cb'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' })
const world = await tlsWorld([HOST, 'other.example.test'])
const reason = async (p: Promise<unknown>) => { try { await p; return 'OK' } catch (e) { return e instanceof oauth.MetadataFetchError ? e.reason : String(e) } }
const reset = () => { world.connections.length = 0; world.setHandler((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(doc()) }) }
const fetchWith = (net: oauth.FetchNetwork, url = URL_OK, opts: { timeoutMs?: number; maxBytes?: number } = {}) => oauth.fetchMetadataDocument(url, net, opts)

// D1 resolution count and pinning
reset()
let resolves = 0
const countingNet = (answers: string[][]): oauth.FetchNetwork => {
  const real = world.network()
  return { async resolve(h) { const a = answers[Math.min(resolves, answers.length - 1)] ?? []; resolves++; return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 } as const)) }, connect: (t) => real.connect(t) }
}
check('D1 resolves exactly once per fetch', 1, await (async () => { resolves = 0; await fetchWith(countingNet([[PUBLIC_ADDRESS]])); return resolves })())
check('D1 connects to the first resolved address only', [PUBLIC_ADDRESS], await (async () => { reset(); await fetchWith(countingNet([[PUBLIC_ADDRESS, '192.175.48.2']])); return world.connections.slice() })())
check('D1 rebinding: 1st answer public, 2nd private -> the 2nd is never asked, never connected', { reason: 'OK', resolves: 1, connections: [PUBLIC_ADDRESS] }, await (async () => { reset(); resolves = 0; const r = await reason(fetchWith(countingNet([[PUBLIC_ADDRESS], ['127.0.0.1']]))); return { reason: r, resolves, connections: world.connections.slice() } })())
check('D1 round robin: one private answer among public ones refuses the whole fetch, no connect', { reason: 'address_refused', connections: [] }, await (async () => { reset(); resolves = 0; const r = await reason(fetchWith(countingNet([[PUBLIC_ADDRESS, '10.0.0.5']]))); return { reason: r, connections: world.connections.slice() } })())
check('D1 first answer private, second public: refused (not "try the next")', { reason: 'address_refused', connections: [] }, await (async () => { reset(); resolves = 0; const r = await reason(fetchWith(countingNet([['169.254.169.254', PUBLIC_ADDRESS]]))); return { reason: r, connections: world.connections.slice() } })())
check('D1 empty answer', 'dns_failed', await reason(fetchWith(countingNet([[]]))))
check('D1 resolver throws', 'dns_failed', await reason(fetchWith({ resolve: async () => { throw new Error('ENOTFOUND') }, connect: world.network().connect })))
check('D1 resolver hangs -> timeout (500 ms budget)', 'timeout', await reason(fetchWith({ resolve: () => new Promise(() => {}), connect: world.network().connect }, URL_OK, { timeoutMs: 500 })))
for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '169.254.169.254', '100.64.0.1', '10.1.2.3', '172.16.9.9', '192.168.1.1', 'fc00::5', 'fd00:ec2::254', 'fe80::1']) {
  check(`D1 name resolving to ${a} is refused before any connect`, { reason: 'address_refused', connections: [] }, await (async () => { reset(); const r = await reason(fetchWith(countingNet([[a]]))); return { reason: r, connections: world.connections.slice() } })())
}
// D2 the real system resolver on names that exist on every machine
{
  const sys = oauth.systemNetwork()
  const loc = await sys.resolve('localhost').catch(() => [])
  check('D2 system resolver: localhost resolves, every answer non-public', true, loc.length > 0 && loc.every((a) => !oauth.isPublicAddress(a.address)), `answers ${loc.map((a) => a.address).join(',')}`)
  check('D2 fetch of https://localhost.example.invalid-style URL never reaches the network: a localhost URL is url_invalid', 'url_invalid', await reason(oauth.fetchMetadataDocument('https://localhost/c.json', sys)))
  const loop = await sys.resolve('localhost.localdomain').catch(() => null)
  note('D2', `localhost.localdomain resolves to ${loop === null ? 'nothing (no such host here)' : loop.map((a) => a.address).join(',')}; the parser lets the name through, the address check would stop it`)
}
// D3 redirects: every 3xx refused, never followed (the redirect target is never connected)
for (const code of [301, 302, 303, 307, 308]) {
  check(`D3 status ${code} with a Location to a private address -> redirect_refused, one connection`, { reason: 'redirect_refused', connections: 1 }, await (async () => {
    reset(); world.setHandler((_q, r) => { r.statusCode = code; r.setHeader('location', 'https://127.0.0.1/c.json'); r.setHeader('content-type', 'application/json'); r.end(doc()) })
    const r = await reason(fetchWith(world.network())); return { reason: r, connections: world.connections.length }
  })())
}
check('D3 status 304 -> redirect_refused (any 3xx)', 'redirect_refused', await (async () => { reset(); world.setHandler((_q, r) => { r.statusCode = 304; r.end() }); return reason(fetchWith(world.network())) })())
for (const code of [201, 202, 204, 206, 401, 403, 404, 500]) {
  check(`D3 status ${code} -> status_refused`, 'status_refused', await (async () => { reset(); world.setHandler((_q, r) => { r.statusCode = code; r.setHeader('content-type', 'application/json'); r.end(code === 204 ? undefined : doc()) }); return reason(fetchWith(world.network())) })())
}
// D4 media type and encoding on the wire
for (const [ct, want] of [['text/html', 'content_type_refused'], ['text/json', 'content_type_refused'], ['application/json; charset=utf-16', 'content_type_refused'], ['application/ld+json', 'OK'], ['application/json;charset=UTF-8', 'OK']] as const) {
  check(`D4 Content-Type ${ct}`, want, await (async () => { reset(); world.setHandler((_q, r) => { r.setHeader('content-type', ct); r.end(doc()) }); return reason(fetchWith(world.network())) })())
}
check('D4 no Content-Type at all', 'content_type_refused', await (async () => { reset(); world.setHandler((_q, r) => { r.end(doc()) }); return reason(fetchWith(world.network())) })())
check('D4 Content-Encoding: gzip', 'encoding_refused', await (async () => { reset(); world.setHandler((_q, r) => { r.setHeader('content-type', 'application/json'); r.setHeader('content-encoding', 'gzip'); r.end(doc()) }); return reason(fetchWith(world.network())) })())
check('D4 invalid UTF-8 body', 'content_type_refused', await (async () => { reset(); world.setHandler((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])) }); return reason(fetchWith(world.network())) })())
// D5 size
const sized = (size: number) => `${doc()}${' '.repeat(size - Buffer.byteLength(doc()))}`
for (const [size, want] of [[5119, 'OK'], [5120, 'OK'], [5121, 'too_large'], [65536, 'too_large'], [1_000_000, 'too_large']] as const) {
  check(`D5 body of ${size} bytes`, want, await (async () => { reset(); world.setHandler((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(sized(size)) }); return reason(fetchWith(world.network())) })())
}
check('D5 chunked, no Content-Length, 1 MiB', 'too_large', await (async () => { reset(); world.setHandler((_q, r) => { r.setHeader('content-type', 'application/json'); r.write(' '.repeat(1 << 20)); r.end(doc()) }); return reason(fetchWith(world.network())) })())
check('D5 huge header block (64 KiB)', true, await (async () => { reset(); world.setHandler((_q, r) => { r.setHeader('content-type', 'application/json'); r.setHeader('x-pad', 'a'.repeat(60000)); r.end(doc()) }); return (await reason(fetchWith(world.network()))) !== 'OK' })())
// D6 time
check('D6 slow drip body (1 byte / 200 ms) against a 1 s budget', 'timeout', await (async () => {
  reset(); world.setHandler((_q, r) => { r.setHeader('content-type', 'application/json'); r.write(' '); const t = setInterval(() => r.write(' '), 200); r.on('close', () => clearInterval(t)) })
  return reason(fetchWith(world.network(), URL_OK, { timeoutMs: 1000 }))
})())
check('D6 server never answers against a 1 s budget', 'timeout', await (async () => { reset(); world.setHandler(() => {}); return reason(fetchWith(world.network(), URL_OK, { timeoutMs: 1000 })) })())
// D7 TLS
check('D7 certificate from an untrusted CA', 'tls_failed', await reason(fetchWith(world.network({}, { untrusted: true }))))
check('D7 certificate for another name (URL host not in the certificate)', 'tls_failed', await reason(fetchWith(world.network(), 'https://third.example.test/oauth/client.json')))
// D8 what the fetcher sends
check('D8 request carries no cookie, authorization or forwarded data', { cookie: undefined, authorization: undefined, forwarded: undefined, accept: 'application/json, application/*+json', ae: 'identity', host: HOST, method: 'GET' }, await (async () => {
  reset(); let seen: Record<string, unknown> = {}
  world.setHandler((q, r) => { seen = { cookie: q.headers['cookie'], authorization: q.headers['authorization'], forwarded: q.headers['x-forwarded-for'] ?? q.headers['forwarded'], accept: q.headers['accept'], ae: q.headers['accept-encoding'], host: q.headers['host'], method: q.method }; r.setHeader('content-type', 'application/json'); r.end(doc()) })
  await fetchWith(world.network()); return seen
})())
// E. what validateClientMetadata does with the members that name a second URL (jwks_uri, logo_uri, ...)
console.log('## E. members that carry URLs the server could be asked to fetch')
{
  const base = JSON.parse(doc())
  for (const m of ['jwks_uri', 'jwks']) check(`E ${m} in a document`, 'keys_not_allowed', (oauth.validateClientMetadata({ ...base, [m]: m === 'jwks' ? { keys: [] } : 'https://127.0.0.1/jwks.json' }, URL_OK, 'x') as { reason?: string }).reason)
  for (const m of ['logo_uri', 'tos_uri', 'policy_uri', 'contacts', 'client_uri']) {
    const r = oauth.validateClientMetadata({ ...base, [m]: m === 'contacts' ? ['a@b.invalid'] : 'https://127.0.0.1/x' }, URL_OK, 'x')
    note(`E ${m}`, `${r.ok ? 'accepted' : `refused (${r.reason})`}; stored: ${r.ok ? JSON.stringify(Object.keys(r.metadata.display)) : '-'}`)
  }
  check('E redirect_uris with a private https host are data (the browser follows them, the server never does)', true, oauth.validateClientMetadata({ ...base, redirect_uris: ['https://10.0.0.1/cb'] }, URL_OK, 'x').ok)
}
await world.close()
console.log(`## summary: ${n} cases, ${fails} FAIL`)
process.exit(fails === 0 ? 0 : 1)

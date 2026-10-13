import {
  AUTH_ROUTES,
  actionDefinition,
  isActionId,
  MCP_TOOL_LIST,
  ROUTE_LIST,
} from '@exponetdb/contracts'
import { expectOk, parseId } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import { HANDLERS, servedRoutes } from '../src/interfaces/http/api.ts'
import {
  clientAddress,
  HttpRefusal,
  isTrustedProxy,
  parseCookies,
  problemResponse,
  readLimitedText,
  setCookie,
} from '../src/interfaces/http/request.ts'
import { WEB_CSP } from '../src/interfaces/http/web.ts'

describe('served routes', () => {
  it('every /auth ceremony and every Wave 3A and 3B resource route has a handler, and nothing else is invented', () => {
    const served = ROUTE_LIST.filter(
      (r) =>
        isActionId(r.action) &&
        (actionDefinition(r.action).wave === '3A' || actionDefinition(r.action).wave === '3B'),
    )
    expect(served.length).toBeGreaterThanOrEqual(40)
    for (const route of [...AUTH_ROUTES, ...served]) {
      expect(HANDLERS[route.operationId], route.operationId).toBeDefined()
    }
    const known = new Set([...AUTH_ROUTES, ...ROUTE_LIST].map((r) => r.operationId))
    for (const name of Object.keys(HANDLERS)) {
      expect(known.has(name), name).toBe(true)
    }
    const paths = servedRoutes().map(({ base, route }) => `${route.method} ${base}${route.path}`)
    expect(paths).toContain('post /auth/login/passkey')
    expect(paths).toContain('post /api/v1/plans/{planId}/apply')
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('served routes (Wave 2 and 4 to 8)', () => {
  it('serves every Wave 4 route of the contract and no route of a later wave', () => {
    const wave4 = ROUTE_LIST.filter(
      (r) => isActionId(r.action) && actionDefinition(r.action).wave === '4',
    )
    expect(wave4.length).toBeGreaterThanOrEqual(40)
    for (const route of wave4) {
      expect(HANDLERS[route.operationId], route.operationId).toBeDefined()
    }
    const servedWaves = new Set(
      servedRoutes()
        .filter(({ route }) => isActionId(route.action))
        .map(({ route }) => actionDefinition(route.action).wave),
    )
    for (const wave of servedWaves) {
      expect(['2', '3A', '3B', '4', '5', '6', '7', '8'], `wave ${wave}`).toContain(wave)
    }
  })

  it('serves exactly the Wave 5 node routes of Phases 3, 5 and 6 (control-plane.md §7, §9)', () => {
    const served = servedRoutes()
      .filter(
        ({ route }) => isActionId(route.action) && actionDefinition(route.action).wave === '5',
      )
      .map(({ route }) => route.operationId)
      .sort()
    expect(served).toEqual([
      'getNode',
      'inspectNode',
      'listNodeObservations',
      'listNodes',
      'planCredentialRotation',
      'planNodeConfigUpdate',
      'planNodeDecommissioning',
      'planNodeEnrollment',
      'planNodeOperation',
      'planNodeRevocation',
      'revealEnrollmentToken',
    ])
  })

  it('serves the Wave 6 routes built so far, each with a handler', () => {
    const served = servedRoutes()
      .filter(
        ({ route }) => isActionId(route.action) && actionDefinition(route.action).wave === '6',
      )
      .map(({ route }) => route.operationId)
      .sort()
    expect(served).toEqual([
      'activateBreakGlass',
      'cancelOperation',
      'cancelStepUp',
      'confirmStepUp',
      'decideImportItem',
      'getBundle',
      'getBundleFile',
      'getImportReport',
      'getMigrationStream',
      'getStepUp',
      'getTargetMigration',
      'getTargetMigrations',
      'ingestBundles',
      'lintMigrations',
      'listPlans',
      'planBaseline',
      'planImportAnalysis',
      'planMigrationResume',
      'planMigrationRollback',
      'planMigrations',
      'requestStepUp',
      'retryOperationVerification',
      'verifyMigration',
    ])
  })

  it('serves exactly the Wave 7 data-read routes (ADR-0028), each with a handler', () => {
    const served = servedRoutes()
      .filter(
        ({ route }) => isActionId(route.action) && actionDefinition(route.action).wave === '7',
      )
      .map(({ route }) => route.operationId)
      .sort()
    expect(served).toEqual(['cancelQuery', 'explainQuery', 'runQuery'])
  })

  it('serves exactly the Wave 2 routes: the installation, its health (since Wave 8), plans, operations and the audit search', () => {
    const served = servedRoutes()
      .filter(
        ({ route }) => isActionId(route.action) && actionDefinition(route.action).wave === '2',
      )
      .map(({ route }) => route.operationId)
      .sort()
    expect(served).toEqual([
      'applyPlan',
      'getInstallation',
      'getInstallationHealth',
      'getOperation',
      'getPlan',
      'listOperations',
      'searchAuditEvents',
      'withdrawPlan',
    ])
  })

  it('serves exactly the Wave 8 reads of the Web App (order §9), each with a handler and none of them an MCP tool', () => {
    const served = servedRoutes()
      .filter(
        ({ route }) => isActionId(route.action) && actionDefinition(route.action).wave === '8',
      )
      .map(({ route }) => route.operationId)
      .sort()
    expect(served).toEqual([
      'classifySql',
      // Endpoints 6 and 7: the own query history and the saved queries.
      'createSavedQuery',
      'deleteSavedQuery',
      'getAuditChain',
      'getFleet',
      'getSavedQuery',
      'getTargetHealthHistory',
      'listBreakGlassGrants',
      'listFindings',
      'listNodeCertificates',
      'listNodeJobs',
      'listQueryHistory',
      'listSavedQueries',
      // Wave 8, order §9 endpoint 3: drift acceptance (a plan, applied through plan.apply).
      'planDriftAcceptance',
      'reviewBreakGlassGrant',
      'updateSavedQuery',
    ])
    for (const { route } of servedRoutes()) {
      if (isActionId(route.action) && actionDefinition(route.action).wave === '8') {
        expect(actionDefinition(route.action).clientKinds, route.operationId).not.toContain('mcp')
        expect(
          MCP_TOOL_LIST.some((t) => t.action === route.action),
          route.operationId,
        ).toBe(false)
      }
    }
  })

  it('leaves exactly the Wave 9 routes and the ledger reconciliation plan unserved', () => {
    const served = new Set(servedRoutes().map(({ route }) => route.operationId))
    expect(
      ROUTE_LIST.filter((r) => !served.has(r.operationId))
        .map((r) => r.operationId)
        .sort(),
    ).toEqual([
      'getQueryStats',
      'getTableStats',
      'listClusterBackups',
      'planLedgerReconcile',
      'runAdvisors',
    ])
  })
})

describe('client address', () => {
  it('ignores X-Forwarded-For from an untrusted peer', () => {
    expect(clientAddress('203.0.113.9', '198.51.100.1', [])).toBe('203.0.113.9')
    expect(clientAddress('203.0.113.9', '198.51.100.1', ['10.0.0.0/8'])).toBe('203.0.113.9')
  })

  it('takes the right-most untrusted hop behind trusted proxies', () => {
    expect(clientAddress('10.0.0.5', '198.51.100.1', ['10.0.0.0/8'])).toBe('198.51.100.1')
    expect(clientAddress('10.0.0.5', '1.2.3.4, 198.51.100.1, 10.0.0.7', ['10.0.0.0/8'])).toBe(
      '198.51.100.1',
    )
    expect(clientAddress('::ffff:10.0.0.5', '198.51.100.1', ['10.0.0.5'])).toBe('198.51.100.1')
    // A malformed hop is never believed.
    expect(clientAddress('10.0.0.5', 'nonsense', ['10.0.0.0/8'])).toBe('10.0.0.5')
  })

  it('matches IPv4 ranges exactly', () => {
    expect(isTrustedProxy('172.18.0.2', ['172.16.0.0/12'])).toBe(true)
    expect(isTrustedProxy('172.32.0.1', ['172.16.0.0/12'])).toBe(false)
    expect(isTrustedProxy('10.0.0.1', [])).toBe(false)
  })

  it('matches IPv6 addresses and ranges, never across families', () => {
    expect(isTrustedProxy('fd00:10::5', ['fd00:10::/64'])).toBe(true)
    expect(isTrustedProxy('fd00:11::5', ['fd00:10::/64'])).toBe(false)
    expect(isTrustedProxy('2001:db8::1', ['2001:db8::1'])).toBe(true)
    expect(isTrustedProxy('10.0.0.1', ['fd00::/8'])).toBe(false)
    expect(isTrustedProxy('::ffff:10.0.0.5', ['10.0.0.0/8'])).toBe(true)
    expect(clientAddress('fd00:10::5', '2001:db8::7, fd00:10::9', ['fd00:10::/64'])).toBe(
      '2001:db8::7',
    )
    expect(isTrustedProxy('not-an-address', ['0.0.0.0/0'])).toBe(false)
  })
})

describe('cookies and problems', () => {
  it('builds __Host- cookies with Secure, Path=/, SameSite=Strict and no Domain', () => {
    const cookie = setCookie('__Host-exdb_session', 'exst_x', {
      maxAgeSeconds: 43_200,
      httpOnly: true,
    })
    expect(cookie).toBe(
      '__Host-exdb_session=exst_x; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200',
    )
    expect(
      setCookie('__Host-exdb_csrf', 'exck_x', { maxAgeSeconds: 10, httpOnly: false }),
    ).not.toContain('HttpOnly')
  })

  it('parses only well-formed cookie values; the first of duplicates wins', () => {
    const jar = parseCookies('a=one; a=two; bad=<script>; __Host-exdb_session=exst_abc')
    expect(jar.get('a')).toBe('one')
    expect(jar.has('bad')).toBe(false)
    expect(jar.get('__Host-exdb_session')).toBe('exst_abc')
  })

  it('never sends details that do not match the catalog, and sets Retry-After on rate limits', async () => {
    const requestId = expectOk(parseId('req', 'req_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'), 'request id')
    const bad = problemResponse(requestId, new HttpRefusal('PASSWORD_REJECTED', { secret: 'x' }))
    expect(bad.status).toBe(500)
    const limited = problemResponse(requestId, new HttpRefusal('RATE_LIMITED'), {
      retryAfterSeconds: 4.2,
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('5')
    // The same wait is in the body too (the tool error of MCP carries it).
    expect(await limited.json()).toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 5 },
    })
    const unknownWait = problemResponse(requestId, new HttpRefusal('RATE_LIMITED'))
    expect(unknownWait.status).toBe(429)
    expect(unknownWait.headers.get('retry-after')).toBeNull()
    expect(await unknownWait.json()).not.toHaveProperty('details')
    const unknown = problemResponse(requestId, new Error('boom'))
    const body: unknown = await unknown.json()
    expect(body).toMatchObject({ code: 'INTERNAL' })
    expect(JSON.stringify(body)).not.toContain('boom')
  })

  it('the Web App CSP allows no inline script and no other origin', () => {
    expect(WEB_CSP).toContain("script-src 'self'")
    expect(WEB_CSP).not.toMatch(/unsafe-|\*|https?:/)
  })
})

describe('request bodies', () => {
  it('stop reading a body past the limit, whatever Content-Length says or without one', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024).fill(0x61))
      },
    })
    const chunked = new Request('https://db.example.test/auth/login/password', {
      method: 'POST',
      body: endless,
      duplex: 'half',
    })
    expect(await readLimitedText(chunked, 4096)).toBeUndefined()
    expect(pulled).toBeLessThan(10)

    const declared = new Request('https://db.example.test/x', {
      method: 'POST',
      headers: { 'content-length': '999999' },
      body: '{}',
    })
    expect(await readLimitedText(declared, 4096)).toBeUndefined()
    const ok = new Request('https://db.example.test/x', { method: 'POST', body: '{"a":"ä"}' })
    expect(await readLimitedText(ok, 4096)).toBe('{"a":"ä"}')
    const invalid = new Request('https://db.example.test/x', {
      method: 'POST',
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    })
    expect(await readLimitedText(invalid, 4096)).toBeUndefined()
  })
})

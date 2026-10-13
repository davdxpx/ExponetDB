import { describe, expect, it } from 'vitest'
import {
  authOperatorConfig,
  ConfigError,
  gatewayConfig,
  serveConfig,
  storeCommandConfig,
  workerConfig,
} from '../src/config/env.ts'

// Assembled so that the repository's secret scanner keeps its URL rule strict (fake credentials).
const SECRET_URL = [
  'postgres://exdb_serve:',
  's3cr3t-password-value',
  '@control-store:5432/exponetdb_control',
].join('')
const KEYRING = '{"format":"exponetdb.keyring/v1","keys":[]}'
const base = {
  EXPONETDB_CONTROL_STORE_URL: SECRET_URL,
  EXPONETDB_INSTALLATION_ID: 'ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
  EXPONETDB_KEYRING: KEYRING,
  PATH: '/usr/bin',
}
const serveBase = { ...base, EXPONETDB_PUBLIC_URL: 'https://db.exponet.cloud' }

function problems(fn: () => unknown): { variable: string; reason: string }[] {
  try {
    fn()
  } catch (error) {
    if (error instanceof ConfigError) {
      expect(error.message).not.toContain('s3cr3t')
      expect(error.message).not.toContain('keyring/v1')
      return [...error.problems]
    }
    throw error
  }
  throw new Error('expected a configuration error')
}

describe('Wave 3A authentication configuration', () => {
  it('serve needs the public origin; the RP id is its host or a parent, never another host', () => {
    expect(problems(() => serveConfig(base))).toEqual([
      { variable: 'EXPONETDB_PUBLIC_URL', reason: 'missing' },
    ])
    expect(serveConfig(serveBase)).toMatchObject({
      publicUrl: 'https://db.exponet.cloud',
      webauthnRpId: undefined,
      trustedProxies: [],
    })
    expect(
      serveConfig({ ...serveBase, EXPONETDB_WEBAUTHN_RP_ID: 'exponet.cloud' }).webauthnRpId,
    ).toBe('exponet.cloud')
    expect(
      problems(() => serveConfig({ ...serveBase, EXPONETDB_WEBAUTHN_RP_ID: 'evil.example' })),
    ).toEqual([{ variable: 'EXPONETDB_WEBAUTHN_RP_ID', reason: 'not_the_host_or_a_parent' }])
    expect(
      problems(() =>
        serveConfig({ ...serveBase, EXPONETDB_PUBLIC_URL: 'https://db.exponet.cloud/app' }),
      ),
    ).toEqual([{ variable: 'EXPONETDB_PUBLIC_URL', reason: 'origin_only' }])
  })

  it('trusted proxies are explicit addresses or ranges', () => {
    expect(
      serveConfig({ ...serveBase, EXPONETDB_TRUSTED_PROXIES: '10.0.0.0/8, 172.18.0.2' })
        .trustedProxies,
    ).toEqual(['10.0.0.0/8', '172.18.0.2'])
    expect(
      serveConfig({ ...serveBase, EXPONETDB_TRUSTED_PROXIES: 'fd00:10::/64, 2001:db8::1' })
        .trustedProxies,
    ).toEqual(['fd00:10::/64', '2001:db8::1'])
    for (const bad of ['10.0.0.0/33', 'fd00::/129', '10.0.0.0/8/1', '300.1.1.1', 'fd00::/x']) {
      expect(
        problems(() => serveConfig({ ...serveBase, EXPONETDB_TRUSTED_PROXIES: bad })),
        bad,
      ).toEqual([{ variable: 'EXPONETDB_TRUSTED_PROXIES', reason: 'invalid' }])
    }
    expect(problems(() => serveConfig({ ...serveBase, EXPONETDB_TRUSTED_PROXIES: '*' }))).toEqual([
      { variable: 'EXPONETDB_TRUSTED_PROXIES', reason: 'invalid' },
    ])
  })

  it('egress addresses are single addresses, at most eight', () => {
    expect(serveConfig(serveBase).egressAddresses).toEqual([])
    expect(
      serveConfig({ ...serveBase, EXPONETDB_EGRESS_ADDRESSES: '10.8.2.2, fd00::2, 10.8.2.2' })
        .egressAddresses,
    ).toEqual(['10.8.2.2', 'fd00::2'])
    for (const bad of ['10.8.2.0/24', 'reos-01', '300.1.1.1', 'FD00::2', '1.1.1.1,'.repeat(9)]) {
      expect(
        problems(() => serveConfig({ ...serveBase, EXPONETDB_EGRESS_ADDRESSES: bad })),
        bad,
      ).toEqual([{ variable: 'EXPONETDB_EGRESS_ADDRESSES', reason: 'invalid' }])
    }
  })

  it('MCP origins are exact HTTPS origins, at most eight', () => {
    expect(serveConfig(serveBase).mcpAllowedOrigins).toEqual([])
    expect(
      serveConfig({
        ...serveBase,
        EXPONETDB_MCP_ALLOWED_ORIGINS:
          'https://claude.ai, https://app.example.test,https://claude.ai',
      }).mcpAllowedOrigins,
    ).toEqual(['https://claude.ai', 'https://app.example.test'])
    for (const [bad, reason] of [
      ['null', 'invalid'],
      ['http://app.example.test', 'https_required'],
      ['https://app.example.test/', 'origin_only'],
      ['https://app.example.test/path', 'origin_only'],
      ['https://*.example.test', 'invalid'],
      ['https://user:pw@app.example.test', 'credentials_in_url'],
      [Array.from({ length: 9 }, (_, i) => `https://a${i}.example.test`).join(','), 'invalid'],
    ] as const) {
      expect(
        problems(() => serveConfig({ ...serveBase, EXPONETDB_MCP_ALLOWED_ORIGINS: bad })),
        bad,
      ).toEqual([{ variable: 'EXPONETDB_MCP_ALLOWED_ORIGINS', reason }])
    }
  })

  it('admits new MCP clients openly by default, or for review (owner decision 2026-10-13)', () => {
    expect(serveConfig(serveBase).clientRegistration).toBe('open')
    expect(
      serveConfig({ ...serveBase, EXPONETDB_OAUTH_CLIENT_REGISTRATION: 'review' })
        .clientRegistration,
    ).toBe('review')
    expect(
      problems(() => serveConfig({ ...serveBase, EXPONETDB_OAUTH_CLIENT_REGISTRATION: 'closed' })),
    ).toEqual([{ variable: 'EXPONETDB_OAUTH_CLIENT_REGISTRATION', reason: 'invalid' }])
  })

  it('the auth operator commands use the serve login and the public origin', () => {
    expect(
      authOperatorConfig({
        EXPONETDB_CONTROL_STORE_URL: SECRET_URL,
        EXPONETDB_PUBLIC_URL: 'https://db.exponet.cloud',
      }),
    ).toMatchObject({ publicUrl: 'https://db.exponet.cloud' })
    expect(
      problems(() =>
        authOperatorConfig({ EXPONETDB_CONTROL_STORE_URL: SECRET_URL, EXPONETDB_KEYRING: KEYRING }),
      ),
    ).toEqual(
      expect.arrayContaining([
        { variable: 'EXPONETDB_KEYRING', reason: 'not_used_by_auth_operator' },
        { variable: 'EXPONETDB_PUBLIC_URL', reason: 'missing' },
      ]),
    )
  })
})

describe('role configuration', () => {
  it('accepts a minimal serve configuration with defaults', () => {
    const config = serveConfig(serveBase)
    expect(config).toMatchObject({
      role: 'serve',
      listen: { host: '0.0.0.0', port: 8080 },
      internalListen: { host: '127.0.0.1', port: 9464 },
      logLevel: 'info',
      shutdownTimeoutMs: 25_000,
    })
  })

  it('refuses unknown EXPONETDB_ variables, typos included, and names only the variable', () => {
    expect(problems(() => serveConfig({ ...serveBase, EXPONETDB_LISTN: '0.0.0.0:80' }))).toEqual([
      { variable: 'EXPONETDB_LISTN', reason: 'unknown_variable' },
    ])
  })

  it('refuses variables of another role', () => {
    expect(
      problems(() => workerConfig({ ...base, EXPONETDB_PUBLIC_URL: 'https://db.exponet.cloud' })),
    ).toEqual([{ variable: 'EXPONETDB_PUBLIC_URL', reason: 'not_used_by_worker' }])
    expect(problems(() => serveConfig({ ...serveBase, EXPONETDB_AUDIT_EXPORT_DIR: '/x' }))).toEqual(
      [{ variable: 'EXPONETDB_AUDIT_EXPORT_DIR', reason: 'not_used_by_serve' }],
    )
  })

  it('reads the agent listener for the gateway only (Wave 5)', () => {
    expect(gatewayConfig(base).agentListen).toBeUndefined()
    expect(
      gatewayConfig({ ...base, EXPONETDB_GATEWAY_LISTEN: '10.8.2.2:7443' }).agentListen,
    ).toEqual({ host: '10.8.2.2', port: 7443 })
    expect(
      problems(() => gatewayConfig({ ...base, EXPONETDB_GATEWAY_LISTEN: 'gateway:7443' })),
    ).toEqual([{ variable: 'EXPONETDB_GATEWAY_LISTEN', reason: 'invalid' }])
    expect(
      problems(() => workerConfig({ ...base, EXPONETDB_GATEWAY_LISTEN: '10.8.2.2:7443' })),
    ).toEqual([{ variable: 'EXPONETDB_GATEWAY_LISTEN', reason: 'not_used_by_worker' }])
  })

  it('requires the Control Store URL, the installation id and exactly one keyring source', () => {
    const {
      EXPONETDB_CONTROL_STORE_URL: _u,
      EXPONETDB_INSTALLATION_ID: _i,
      EXPONETDB_KEYRING: _k,
      ...rest
    } = base
    expect(
      problems(() => serveConfig(rest))
        .map((p) => p.variable)
        .sort(),
    ).toEqual(['EXPONETDB_CONTROL_STORE_URL', 'EXPONETDB_INSTALLATION_ID', 'EXPONETDB_KEYRING'])
    expect(
      problems(() => serveConfig({ ...serveBase, EXPONETDB_KEYRING_FILE: '/run/keyring.json' })),
    ).toEqual([{ variable: 'EXPONETDB_KEYRING_FILE', reason: 'keyring_ambiguous' }])
  })

  it('validates values without echoing them', () => {
    const found = problems(() =>
      serveConfig({
        ...base,
        EXPONETDB_CONTROL_STORE_URL: ['mysql://user:', 's3cr3t-password-value', '@x/y'].join(''),
        EXPONETDB_INSTALLATION_ID: 'not-an-id',
        EXPONETDB_LISTEN: '0.0.0.0:99999',
        EXPONETDB_PUBLIC_URL: 'http://db.exponet.cloud',
        EXPONETDB_LOG_LEVEL: 'verbose',
        EXPONETDB_ROLE: 'worker',
      }),
    )
    expect(found).toEqual(
      expect.arrayContaining([
        { variable: 'EXPONETDB_CONTROL_STORE_URL', reason: 'invalid' },
        { variable: 'EXPONETDB_INSTALLATION_ID', reason: 'invalid' },
        { variable: 'EXPONETDB_ROLE', reason: 'role_mismatch' },
        { variable: 'EXPONETDB_LOG_LEVEL', reason: 'invalid' },
      ]),
    )
  })

  it('worker audit export: one sink, complete S3 settings, https only', () => {
    expect(
      workerConfig({ ...base, EXPONETDB_AUDIT_EXPORT_DIR: '/var/lib/exponetdb/checkpoints' })
        .auditExport,
    ).toEqual({
      kind: 'file',
      directory: '/var/lib/exponetdb/checkpoints',
    })
    const s3 = {
      EXPONETDB_AUDIT_S3_ENDPOINT: 'https://fsn1.your-objectstorage.com',
      EXPONETDB_AUDIT_S3_REGION: 'fsn1',
      EXPONETDB_AUDIT_S3_BUCKET: 'exponetdb-audit',
      EXPONETDB_AUDIT_S3_ACCESS_KEY_ID: 'access',
      EXPONETDB_AUDIT_S3_SECRET_ACCESS_KEY: 'secret-value-never-shown',
      EXPONETDB_AUDIT_S3_OBJECT_LOCK_MODE: 'COMPLIANCE',
      EXPONETDB_AUDIT_S3_OBJECT_LOCK_DAYS: '3650',
    }
    expect(workerConfig({ ...base, ...s3 }).auditExport).toMatchObject({
      kind: 's3',
      bucket: 'exponetdb-audit',
      objectLock: { mode: 'COMPLIANCE', days: 3650 },
    })
    expect(
      problems(() =>
        workerConfig({ ...base, ...s3, EXPONETDB_AUDIT_S3_ENDPOINT: 'http://storage.example' }),
      ),
    ).toEqual([{ variable: 'EXPONETDB_AUDIT_S3_ENDPOINT', reason: 'https_required' }])
    const { EXPONETDB_AUDIT_S3_SECRET_ACCESS_KEY: _s, ...incomplete } = s3
    expect(problems(() => workerConfig({ ...base, ...incomplete }))).toEqual([
      { variable: 'EXPONETDB_AUDIT_S3_SECRET_ACCESS_KEY', reason: 'missing' },
    ])
    expect(problems(() => workerConfig({ ...base, EXPONETDB_AUDIT_S3_BUCKET: 'x' }))).toEqual([
      { variable: 'EXPONETDB_AUDIT_S3_BUCKET', reason: 'requires_EXPONETDB_AUDIT_S3_ENDPOINT' },
    ])
  })
})

describe('one-shot command configuration', () => {
  it('migrate takes only a Control Store URL and logging', () => {
    expect(
      storeCommandConfig({ EXPONETDB_CONTROL_STORE_URL: SECRET_URL }, 'migrate').controlStoreUrl,
    ).toBe(SECRET_URL)
    expect(
      problems(() =>
        storeCommandConfig(
          { EXPONETDB_CONTROL_STORE_URL: SECRET_URL, EXPONETDB_KEYRING: KEYRING },
          'migrate',
        ),
      ),
    ).toEqual([{ variable: 'EXPONETDB_KEYRING', reason: 'not_used_by_migrate' }])
  })
})

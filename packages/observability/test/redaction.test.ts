import { expectOk, parseId } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import {
  createLogger,
  describeError,
  redactText,
  SafeError,
  sanitizeFields,
  withCorrelation,
} from '../src/index.ts'

/**
 * Redaction corpus (G2 security item, self-observability.md §2). Every value
 * below is assembled at run time from harmless parts, so this file never
 * contains a real-looking secret and the repository secret scan stays clean.
 * Each case names the secret substring that must not reach the output.
 */
const j = (...parts: string[]): string => parts.join('')

interface Case {
  readonly name: string
  readonly input: string
  readonly secret: string
}

const SECRET = j('hunter', '2-', 'Sup3r', 'S3cret')
const TOKEN = j('tok', 'en-', 'Zm9vYmFyYmF6', 'cXV4')
const JWT = j(
  'eyJ',
  'hbGciOiJIUzI1NiJ9',
  '.',
  'eyJ',
  'zdWIiOiIxMjM0NTY3ODkwIn0',
  '.',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
)

const CORPUS: readonly Case[] = [
  {
    name: 'postgres URL',
    input: j('postgres', '://exdb_serve:', SECRET, '@control:5432/exponetdb_control'),
    secret: SECRET,
  },
  {
    name: 'postgresql URL with query',
    input: j('postgresql', '://u:', SECRET, '@h/db?sslmode=require'),
    secret: SECRET,
  },
  {
    name: 'conninfo',
    input: j('host=db user=exdb_worker pass', 'word=', SECRET, ' dbname=x'),
    secret: SECRET,
  },
  { name: 'Authorization header', input: j('Author', 'ization: Bearer ', TOKEN), secret: TOKEN },
  { name: 'lowercase authorization', input: j('author', 'ization=Basic ', TOKEN), secret: TOKEN },
  { name: 'bare bearer', input: j('sent Bea', 'rer ', TOKEN, ' upstream'), secret: TOKEN },
  {
    name: 'cookie header',
    input: j('Coo', 'kie: __Host-exdb_session=', TOKEN, '; theme=dark'),
    secret: TOKEN,
  },
  { name: 'set-cookie', input: j('Set-Coo', 'kie: sid=', TOKEN, '; HttpOnly'), secret: TOKEN },
  { name: 'session-looking value', input: j('session', '_id=', TOKEN), secret: TOKEN },
  { name: 'JWT', input: j('token was ', JWT), secret: JWT.slice(0, 30) },
  {
    name: 'private key block',
    input: j(
      '-----BEGIN ',
      'EC PRIVATE KEY-----\nMHcCAQEEI',
      'Abc123\n-----END ',
      'EC PRIVATE KEY-----',
    ),
    secret: j('MHcCAQEEI', 'Abc123'),
  },
  {
    name: 'AWS access key id',
    input: j('key AK', 'IA', 'ABCDEFGHIJKLMNOP', ' used'),
    secret: j('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
  },
  {
    name: 'AWS secret access key assignment',
    input: j('aws_secret_access', '_key=', 'wJalrXUtnFEMI', 'K7MDENGbPxRfiCYEXAMPLEKEY'),
    secret: j('wJalrXUtnFEMI', 'K7MDENGbPxRfiCYEXAMPLEKEY'),
  },
  {
    name: 'ExponetDB access token (future prefix)',
    input: j('ex', 'at_', 'A1b2C3d4E5f6G7h8I9j0K1l2'),
    secret: j('A1b2C3d4E5f6', 'G7h8I9j0K1l2'),
  },
  {
    name: 'ExponetDB refresh token (future prefix)',
    input: j('ex', 'rt_', 'Q'.repeat(30)),
    secret: 'Q'.repeat(30),
  },
  {
    name: 'ExponetDB API key (future prefix)',
    input: j('ex', 'ak_', 'k'.repeat(30)),
    secret: 'k'.repeat(30),
  },
  {
    name: 'query string token',
    input: j('/callback?code=abc&acc', 'ess_token=', TOKEN, '&state=1'),
    secret: TOKEN,
  },
  { name: 'query string api key', input: j('/x?api', '_key=', TOKEN), secret: TOKEN },
  { name: 'JSON-ish password', input: j('{"pass', 'word": "', SECRET, '"}'), secret: SECRET },
  {
    name: 'keyring assignment',
    input: j('EXPONETDB_KEY', 'RING=', '{"keys":[', SECRET, ']}'),
    secret: SECRET,
  },
  { name: 'client secret', input: j('client', '_secret: ', SECRET), secret: SECRET },
  { name: 'GitHub token', input: j('gh', 'p_', 'a'.repeat(36)), secret: 'a'.repeat(36) },
  { name: 'Anthropic-style key', input: j('s', 'k-ant-', 'b'.repeat(40)), secret: 'b'.repeat(40) },
  {
    name: 'IPv4 address',
    input: j('client 203.', '0.113.', '42 connected'),
    secret: j('203.', '0.113.', '42'),
  },
  {
    name: 'IPv6 address',
    input: j('client 2001:', 'db8:85a3::', '8a2e:370:7334 connected'),
    secret: j('2001:', 'db8:85a3'),
  },
  {
    name: 'PostgreSQL error with statement fragment',
    input: j(
      'ERROR: syntax error at or near "VALUES" STATEMENT: ALTER ROLE x PASS',
      "WORD '",
      SECRET,
      "'",
    ),
    secret: SECRET,
  },
]

describe('redaction corpus: denylist', () => {
  for (const c of CORPUS) {
    it(`redacts ${c.name}`, () => {
      const out = redactText(c.input)
      expect(out).not.toContain(c.secret)
      expect(out).toContain('[REDACTED:')
    })
  }

  it('leaves ordinary operational text alone', () => {
    for (const text of [
      'operation.step.finished',
      'audit.append',
      'sha256:c1:4f0c2a',
      'op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
      'Control Store schema verified',
    ]) {
      expect(redactText(text)).toBe(text)
    }
  })
})

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = []
  return { lines, write: (line) => lines.push(line) }
}

describe('redaction corpus: logger end to end', () => {
  it('never writes a corpus secret, whatever field it is passed in', () => {
    const out = capture()
    const log = createLogger({ role: 'worker', write: out.write, level: 'debug' })
    for (const c of CORPUS) {
      // Unknown fields are dropped; allowlisted string fields are redacted.
      log.info('test.corpus', {
        reason: c.input,
        code: c.input,
        connectionString: c.input,
        password: c.input,
        headers: { authorization: c.input },
        rows: [c.input],
        err: new Error(c.input),
      })
    }
    const all = out.lines.join('\n')
    for (const c of CORPUS) {
      expect(all, c.name).not.toContain(c.secret)
    }
    expect(out.lines).toHaveLength(CORPUS.length)
  })

  it('drops unknown and invalid fields and names them', () => {
    const out = capture()
    createLogger({ role: 'serve', write: out.write }).info('http.request.finished', {
      route: '/healthz/ready',
      status: 200,
      userAgent: 'curl/8',
      ip: '198.51.100.7',
      operationId: 'not-an-id',
      nested: { a: 1 },
    })
    const line = JSON.parse(out.lines[0] ?? '{}')
    expect(line).toMatchObject({
      msg: 'http.request.finished',
      role: 'serve',
      route: '/healthz/ready',
      status: 200,
    })
    expect(line.userAgent).toBeUndefined()
    expect(line.ip).toBeUndefined()
    expect(line.operationId).toBeUndefined()
    expect(line.droppedFields).toEqual(['ip', 'nested', 'operationId', 'userAgent'])
  })

  it('projects errors without their message, detail or stack', () => {
    const pgLike = Object.assign(
      new Error(j('duplicate key value violates unique constraint "x"')),
      {
        name: 'DatabaseError',
        code: '23505',
        detail: j('Key (email)=(someone@', 'example.com) already exists.'),
        where: 'SQL statement',
        constraint: 'x',
      },
    )
    expect(describeError(pgLike)).toEqual({ errorName: 'DatabaseError', errorCode: '23505' })
    const wrapped = new SafeError('control_store_query_failed', 'Control Store query failed.', {
      cause: pgLike,
    })
    expect(describeError(wrapped)).toEqual({
      errorName: 'SafeError',
      errorCode: 'control_store_query_failed',
      errorMessage: 'Control Store query failed.',
      causeCode: '23505',
    })
    const out = capture()
    createLogger({ role: 'worker', write: out.write }).error('control_store.query_failed', {
      err: wrapped,
    })
    expect(out.lines[0]).not.toContain('example.com')
    expect(out.lines[0]).not.toContain('duplicate key')
    expect(out.lines[0]).not.toContain('at ')
    expect(describeError('a thrown string with a secret')).toEqual({ errorName: 'ThrownString' })
    expect(describeError({ code: 'x y z' })).toEqual({ errorName: 'NonError' })
  })

  it('adds correlation ids and refuses prose event names', () => {
    const out = capture()
    const log = createLogger({ role: 'serve', write: out.write })
    withCorrelation(
      {
        requestId: expectOk(parseId('req', 'req_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'), 'test id'),
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      },
      () => {
        log.info('http.request.started')
        log.info('Something happened with target foo')
      },
    )
    const [first, second] = out.lines.map((l) => JSON.parse(l))
    expect(first).toMatchObject({
      requestId: 'req_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    })
    expect(second.msg).toBe('log.invalid_event_name')
  })

  it('never throws, even when the sink throws', () => {
    const log = createLogger({
      role: 'worker',
      write: () => {
        throw new Error('sink down')
      },
    })
    expect(() => log.error('test.sink_down')).not.toThrow()
  })

  it('canary: the sanitizer really runs (a secret in an allowlisted field is changed)', () => {
    const canary = j('pass', 'word=', SECRET)
    const { fields } = sanitizeFields({ reason: canary })
    expect(fields['reason']).not.toBe(canary)
    expect(String(fields['reason'])).not.toContain(SECRET)
  })
})

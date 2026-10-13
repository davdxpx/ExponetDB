import { parseId } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import {
  buildProblem,
  buildToolError,
  ERROR_CODES,
  ERRORS,
  type ErrorCode,
  type ErrorDefinition,
  errorTypeUri,
  internalProblem,
  isErrorCode,
  ProblemSchema,
  ToolErrorSchema,
  validationProblem,
} from '../src/index.ts'
import { readDoc, section, tableRows } from './docs.ts'

const requestIdResult = parseId('req', 'req_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z')
if (!requestIdResult.ok) {
  throw new Error('fixture id invalid')
}
const requestId = requestIdResult.value
const def = (c: ErrorCode): ErrorDefinition => ERRORS[c]

const errorModel = section(readDoc('02-control-plane/error-model.md'), '## 3. Catalog')
const documented = tableRows(errorModel)
  .map((r) => ({
    code: r[0]?.match(/^`([A-Z_]+)`$/)?.[1],
    status: r[1] ?? '',
    retryable: r[2] ?? '',
  }))
  .filter((r): r is { code: string; status: string; retryable: string } => r.code !== undefined)

describe('error catalog', () => {
  it('matches error-model.md §3: same codes, statuses and retryability', () => {
    expect([...ERROR_CODES].sort()).toEqual(documented.map((d) => d.code).sort())
    for (const d of documented) {
      if (!isErrorCode(d.code)) {
        throw new Error(`${d.code} (error-model.md §3) is not a catalog error code`)
      }
      const c = def(d.code)
      const statuses = [...d.status.matchAll(/\d{3}/g)].map((m) => Number(m[0]))
      expect(statuses, d.code).toContain(c.status)
      if (statuses.length > 1) {
        expect(c.statusNote, d.code).toBeDefined()
      }
      expect(c.retryable, d.code).toBe(d.retryable === 'yes')
    }
  })

  it('uses unique, stable UPPER_SNAKE_CASE codes and problem type URIs', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
    const uris = new Set(ERROR_CODES.map(errorTypeUri))
    expect(uris.size).toBe(ERROR_CODES.length)
    for (const c of ERROR_CODES) {
      expect(c).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/)
      expect(errorTypeUri(c)).toMatch(/^https:\/\/db\.exponet\.cloud\/errors\/[a-z0-9-]+$/)
      expect(def(c).status).toBeGreaterThanOrEqual(400)
      expect(def(c).status).toBeLessThan(600)
    }
  })

  it('has fixed public messages without placeholders', () => {
    for (const c of ERROR_CODES) {
      expect(def(c).message, c).not.toMatch(/[{}<>$%]/)
      expect(def(c).message.length, c).toBeGreaterThan(10)
    }
  })

  it('declares strict details schemas: unknown members are refused', () => {
    for (const c of ERROR_CODES) {
      const schema = def(c).details
      if (schema === undefined) {
        continue
      }
      const probe = schema.safeParse({ __secret: 'x' })
      expect(probe.success, c).toBe(false)
    }
  })
})

describe('problem documents', () => {
  it('builds PLAN_STALE from catalog text and validated details', () => {
    const problem = buildProblem('PLAN_STALE', {
      requestId,
      details: {
        planId: 'pln_01JB2ZB3M5P7R9T1V3X5Z7B9D1',
        changedBindings: [
          {
            binding: 'schemaFingerprint',
            expected: `fp1:17:${'a'.repeat(64)}`,
            actual: `fp1:17:${'b'.repeat(64)}`,
          },
        ],
      },
    })
    expect(problem.ok).toBe(true)
    if (problem.ok) {
      expect(ProblemSchema.parse(problem.value)).toEqual(problem.value)
      expect(problem.value).toMatchObject({
        type: 'https://db.exponet.cloud/errors/plan-stale',
        title: 'Plan is stale',
        status: 409,
        code: 'PLAN_STALE',
        retryable: false,
        requestId,
      })
    }
  })

  it('refuses details for codes without a details schema, and invalid details', () => {
    expect(buildProblem('NOT_FOUND', { requestId, details: { anything: 1 } }).ok).toBe(false)
    expect(
      buildProblem('PLAN_STALE', { requestId, details: { planId: 'nope', changedBindings: [] } })
        .ok,
    ).toBe(false)
    expect(buildProblem('PLAN_STALE', { requestId }).ok).toBe(false)
  })

  it('gives RATE_LIMITED optional details: the wait of Retry-After, positive whole seconds', () => {
    // Optional: a rate limit with no known wait is still a RATE_LIMITED problem.
    const plain = buildProblem('RATE_LIMITED', { requestId })
    expect(plain.ok).toBe(true)
    if (plain.ok) {
      expect(plain.value).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryable: true })
      expect(plain.value.details).toBeUndefined()
    }
    for (const build of [buildProblem, buildToolError]) {
      const built = build('RATE_LIMITED', { requestId, details: { retryAfterSeconds: 5 } })
      expect(built.ok).toBe(true)
      if (built.ok) {
        expect(built.value.details).toEqual({ retryAfterSeconds: 5 })
      }
      for (const details of [
        { retryAfterSeconds: 0 },
        { retryAfterSeconds: -1 },
        { retryAfterSeconds: 1.5 },
        { retryAfterSeconds: '5' },
        { retryAfterSeconds: 5, extra: true },
        {},
      ]) {
        expect(build('RATE_LIMITED', { requestId, details }).ok, JSON.stringify(details)).toBe(
          false,
        )
      }
    }
    // Only a schema that accepts its absence makes details optional: PLAN_STALE still needs them.
    expect(buildToolError('PLAN_STALE', { requestId }).ok).toBe(false)
  })

  it('never puts an Error, its message, stack or cause on the wire', () => {
    // Assembled at run time so the repository secret scan does not match a
    // synthetic credential that exists only to prove it never leaks.
    const secret = ['postgres', '://admin', ':hunter2', '@db.internal/prod'].join('')
    const thrown = new Error(`connection failed: ${secret}`, { cause: new Error(secret) })
    // An Error object is not acceptable as details for any code.
    for (const c of ERROR_CODES) {
      expect(buildProblem(c, { requestId, details: thrown }).ok, c).toBe(false)
    }
    // Details that try to smuggle the text in an extra member are refused.
    expect(
      buildProblem('OPERATION_CONFLICT', {
        requestId,
        details: { blockingOperationId: 'op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', cause: secret },
      }).ok,
    ).toBe(false)
    const internal = internalProblem(requestId)
    expect(JSON.stringify(internal)).not.toContain('hunter2')
    expect(Object.keys(internal).sort()).toEqual([
      'code',
      'message',
      'requestId',
      'retryable',
      'status',
      'title',
      'type',
    ])
  })

  it('keeps every catalog text free of secret-like material', () => {
    const text = JSON.stringify(
      ERROR_CODES.map((c) => [def(c).title, def(c).message, def(c).remediation]),
    )
    expect(text).not.toMatch(/password|secret|token=|postgres:\/\/|BEGIN [A-Z ]*PRIVATE KEY/i)
  })

  it('explains itself: the refusals an agent meets most carry a remediation (P-5)', () => {
    // error-model.md §1: "A refusal explains itself". A hidden object answers like an
    // unknown one, so these texts are fixed per code and never say which of the two it was.
    const explained = [
      'TARGET_NOT_FOUND',
      'PLAN_NOT_FOUND',
      'OPERATION_NOT_FOUND',
      'NOT_FOUND',
      'VALIDATION_FAILED',
      'DATA_READ_NOT_PERMITTED',
      'QUERY_NOT_READ_ONLY',
    ] as const
    for (const code of explained) {
      const text = def(code).remediation
      expect(text?.trim().length ?? 0, code).toBeGreaterThan(0)
      expect(text?.length ?? 0, code).toBeLessThanOrEqual(1024)
      const details =
        code === 'VALIDATION_FAILED'
          ? { errors: [{ path: '/x', code: 'invalid', message: 'Bad.' }] }
          : undefined
      const problem = buildProblem(code, { requestId, details })
      const toolError = buildToolError(code, { requestId, details })
      expect(problem.ok && ProblemSchema.parse(problem.value).remediation, code).toBe(text)
      expect(toolError.ok && ToolErrorSchema.parse(toolError.value).remediation, code).toBe(text)
    }
  })

  it('builds the MCP tool error without HTTP fields', () => {
    const toolError = buildToolError('INSUFFICIENT_SCOPE', {
      requestId,
      details: { requiredScope: 'migrations.apply:prod' },
    })
    expect(toolError.ok).toBe(true)
    if (toolError.ok) {
      expect(ToolErrorSchema.parse(toolError.value)).toEqual(toolError.value)
      expect(toolError.value).not.toHaveProperty('status')
      expect(toolError.value).not.toHaveProperty('type')
    }
  })

  it('serializes VALIDATION_FAILED from boundary issues, capped at 100', () => {
    const issues = Array.from({ length: 150 }, (_, i) => ({
      path: `/bundles/${i}`,
      code: 'too_big',
      message: 'Too big.',
    }))
    const problem = validationProblem(requestId, issues)
    expect(problem.ok).toBe(true)
    if (problem.ok) {
      const errors = problem.value.details?.['errors']
      expect(Array.isArray(errors) ? errors.length : -1).toBe(100)
    }
  })

  it('serializes deterministically', () => {
    const a = buildProblem('BREAK_GLASS_REQUIRED', {
      requestId,
      details: { rules: ['migration.staging-evidence'] },
    })
    const b = buildProblem('BREAK_GLASS_REQUIRED', {
      requestId,
      details: { rules: ['migration.staging-evidence'] },
    })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

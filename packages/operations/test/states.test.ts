import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  APPLY_OUTCOMES,
  admits,
  canTransition,
  expandDomains,
  INITIAL_STATES,
  isIdempotencyKey,
  isTerminal,
  OPERATION_STATES,
  type OperationState,
  requestHash,
  TERMINAL_STATES,
  TRANSITIONS,
  VERIFICATION_OUTCOMES,
} from '../src/index.ts'

describe('operation state machine (operations-engine.md §4.1)', () => {
  it('has exactly the documented transitions', () => {
    const edges = OPERATION_STATES.flatMap((from) =>
      TRANSITIONS[from].map((to) => `${from}->${to}`),
    ).sort()
    expect(edges).toEqual(
      [
        'awaiting_approval->queued',
        'awaiting_approval->canceled',
        'queued->running',
        'queued->failed',
        'queued->canceled',
        'running->verifying',
        'running->failed',
        'running->needs_reconciliation',
        'needs_reconciliation->verifying',
        'needs_reconciliation->failed',
        'needs_reconciliation->needs_attention',
        'verifying->succeeded',
        'verifying->verification_failed',
        'verifying->needs_attention',
        'needs_attention->verifying',
      ].sort(),
    )
  })

  it('terminal states have no way out', () => {
    for (const state of TERMINAL_STATES) {
      expect(TRANSITIONS[state]).toEqual([])
      expect(isTerminal(state)).toBe(true)
    }
  })

  it('applied is not verified: success requires an applied change and passed (or no) verification', () => {
    expect(admits('succeeded', 'applied', 'passed')).toBe(true)
    expect(admits('succeeded', 'applied', 'not_applicable')).toBe(true)
    for (const apply of APPLY_OUTCOMES.filter((a) => a !== 'applied')) {
      for (const v of VERIFICATION_OUTCOMES) {
        expect(admits('succeeded', apply, v)).toBe(false)
      }
    }
    for (const v of VERIFICATION_OUTCOMES.filter((x) => x !== 'passed' && x !== 'not_applicable')) {
      expect(admits('succeeded', 'applied', v)).toBe(false)
    }
  })

  it('every state admits at least one outcome pair and states before execution admit no effect', () => {
    for (const state of OPERATION_STATES) {
      const pairs = APPLY_OUTCOMES.flatMap((a) =>
        VERIFICATION_OUTCOMES.map((v) => admits(state, a, v)),
      )
      expect(pairs.some(Boolean), state).toBe(true)
    }
    for (const state of ['awaiting_approval', 'queued', 'running', 'canceled'] as const) {
      expect(admits(state, 'applied', 'pending')).toBe(false)
      expect(admits(state, 'unknown', 'pending')).toBe(false)
    }
  })

  it('property: a random walk from an initial state only reaches succeeded through verifying', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...INITIAL_STATES),
        fc.array(fc.nat(), { maxLength: 20 }),
        (start, choices) => {
          let state: OperationState = start
          let verified = false
          for (const choice of choices) {
            const next = TRANSITIONS[state]
            if (next.length === 0) {
              break
            }
            const to = next[choice % next.length] ?? state
            expect(canTransition(state, to)).toBe(true)
            if (state === 'verifying') {
              verified = true
            }
            state = to
          }
          if (state === 'succeeded') {
            expect(verified).toBe(true)
          }
          if (state === 'verification_failed') {
            expect(verified).toBe(true)
          }
        },
      ),
    )
  })

  it('property: no transition into an initial state and none out of a terminal one', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...OPERATION_STATES),
        fc.constantFrom(...OPERATION_STATES),
        (from, to) => {
          if (isTerminal(from)) {
            expect(canTransition(from, to)).toBe(false)
          }
          if (to === 'awaiting_approval') {
            expect(canTransition(from, to)).toBe(false)
          }
        },
      ),
    )
  })
})

describe('exclusivity domains', () => {
  const t = 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
  const c = 'cls_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
  it('are ordered globally and maintenance includes schema', () => {
    expect(expandDomains([`target:${t}:maintenance`, `cluster:${c}:config`])).toEqual([
      `cluster:${c}:config`,
      `target:${t}:maintenance`,
      `target:${t}:schema`,
    ])
    expect(expandDomains([`target:${t}:schema`, `target:${t}:schema`])).toEqual([
      `target:${t}:schema`,
    ])
  })

  it('refuse anything outside the domain grammar', () => {
    for (const bad of [
      'target:*:schema',
      `target:${t}:everything`,
      'x',
      `target:${t.toLowerCase()}:schema`,
    ]) {
      expect(() => expandDomains([bad])).toThrow()
    }
  })

  it('property: the order does not depend on the input order', () => {
    const domains = [
      `target:${t}:schema`,
      `cluster:${c}:backup`,
      `cluster:${c}:config`,
      `target:${t}:maintenance`,
    ]
    fc.assert(
      fc.property(fc.shuffledSubarray(domains, { minLength: 1 }), (subset) => {
        expect(expandDomains(subset)).toEqual(expandDomains([...subset].reverse()))
      }),
    )
  })
})

describe('idempotency keys', () => {
  it('are 1 to 255 visible ASCII characters', () => {
    expect(isIdempotencyKey('a')).toBe(true)
    expect(isIdempotencyKey('!'.repeat(255))).toBe(true)
    for (const bad of ['', ' ', 'a b', 'ä', 'x'.repeat(256), 'tab\t']) {
      expect(isIdempotencyKey(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('request hashes are canonical over method, path and body', () => {
    const a = requestHash('post', '/api/v1/x', { b: 1, a: [true, null] })
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(requestHash('POST', '/api/v1/x', { a: [true, null], b: 1 })).toBe(a)
    expect(requestHash('POST', '/api/v1/y', { a: [true, null], b: 1 })).not.toBe(a)
  })
})

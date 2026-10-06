import { readFileSync } from 'node:fs'
import { isActionId } from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'

/**
 * Structural guard (C-9, authorization.md §1.1): every public use case of
 * `Application` passes through the central authorization engine before it
 * does anything, and names a contract action. A new method that forgets it
 * fails here, not in review.
 */
const source = readFileSync(new URL('../src/application.ts', import.meta.url), 'utf8')
const classBody = source.slice(source.indexOf('export class Application {'))

/** Methods declared at class level (two-space indentation), with their bodies. */
function methods(): { name: string; body: string }[] {
  const header = /^ {2}(?:async )?(#?[a-zA-Z][a-zA-Z0-9]*)(?:<[^>]*>)?\(/gm
  const starts = [...classBody.matchAll(header)]
  return starts.map((m, i) => ({
    name: m[1] ?? '',
    body: classBody.slice(m.index, starts[i + 1]?.index ?? classBody.length),
  }))
}

/** Not use cases: request authentication itself (it yields the principal). */
const NOT_USE_CASES = new Set(['constructor', 'authenticate', 'authenticateBearer'])
const GATE =
  /this\.(?:#authorize|#ceremony|#selfCeremony|#protocol|#clientDecision|#serviceChange|#plan|#decide|#d\.authorizer\.authorize)(?:<[^>]*>)?\(/

describe('Application', () => {
  const all = methods()

  it('finds the use cases (the guard is not vacuous)', () => {
    expect(all.filter((m) => !m.name.startsWith('#')).length).toBeGreaterThan(40)
  })

  it('every public use case passes through the authorization engine', () => {
    for (const { name, body } of all) {
      if (name.startsWith('#') || NOT_USE_CASES.has(name)) {
        continue
      }
      expect(
        GATE.test(body),
        `${name} must authorize through #authorize, #ceremony, #plan, #decide or the authorizer`,
      ).toBe(true)
    }
  })

  it('the private gates themselves authorize before they act', () => {
    for (const gate of [
      '#ceremony',
      '#selfCeremony',
      '#protocol',
      '#clientDecision',
      '#serviceChange',
      '#plan',
      '#decide',
    ]) {
      const body = all.find((m) => m.name === gate)?.body ?? ''
      expect(body, gate).toContain('this.#authorize(')
    }
  })

  it('every action named in a gate is a contract action', () => {
    const named = [
      ...classBody.matchAll(
        /this\.#(?:ceremony|selfCeremony|protocol|clientDecision|serviceChange|authorize|plan|decide)(?:<[^>]*>)?\([^()'{]*'([a-z_.]+)'/g,
      ),
      ...classBody.matchAll(/\baction: '([a-z_.]+)'/g),
    ]
    expect(named.length).toBeGreaterThan(20)
    for (const m of named) {
      expect(isActionId(m[1] ?? ''), m[1]).toBe(true)
    }
  })
})

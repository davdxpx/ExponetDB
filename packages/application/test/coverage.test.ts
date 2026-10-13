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

/**
 * Not use cases: request authentication itself (it yields the principal),
 * the grant's last use noted for an already authenticated caller (a data
 * basis, never a decision, Wave 7 order §16) and waiting for those
 * background writes.
 */
const NOT_USE_CASES = new Set([
  'constructor',
  'authenticate',
  'authenticateBearer',
  'noteGrantUse',
  'settled',
])
const GATE =
  /this\.(?:#authorize|#admit|#ceremony|#selfCeremony|#protocol|#clientDecision|#serviceChange|#plan|#decide|#mayRead|#d\.authorizer\.authorize)(?:<[^>]*>)?\(/

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
    // A person's own grant (`own_grant`, ADR-0026): the engine's admission phase is the gate.
    expect(all.find((m) => m.name === '#admit')?.body ?? '').toContain('this.#d.authorizer.admit(')
    // Plan and operation reads decide per subject with the engine (OD-26 (c)).
    expect(all.find((m) => m.name === '#mayRead')?.body ?? '').toContain(
      'this.#d.authorizer.authorize(',
    )
  })

  it('every action named in a gate is a contract action', () => {
    const named = [
      ...classBody.matchAll(
        /this\.#(?:ceremony|selfCeremony|protocol|clientDecision|serviceChange|authorize|admit|plan|decide)(?:<[^>]*>)?\([^()'{]*'([a-z_.]+)'/g,
      ),
      ...classBody.matchAll(/\baction: '([a-z_.]+)'/g),
    ]
    expect(named.length).toBeGreaterThan(20)
    for (const m of named) {
      expect(isActionId(m[1] ?? ''), m[1]).toBe(true)
    }
  })
})

describe('MigrationUseCases', () => {
  const text = readFileSync(new URL('../src/migrations.ts', import.meta.url), 'utf8')
  const body = text.slice(text.indexOf('export class MigrationUseCases {'))
  const header = /^ {2}(?:async )?(#?[a-zA-Z][a-zA-Z0-9]*)(?:<[^>]*>)?\(/gm
  const starts = [...body.matchAll(header)]
  const all = starts.map((m, i) => ({
    name: m[1] ?? '',
    body: body.slice(m.index, starts[i + 1]?.index ?? body.length),
  }))

  it('every public use case authorizes on a subject the registry resolved first', () => {
    const cases = all.filter((m) => !m.name.startsWith('#') && m.name !== 'constructor')
    expect(cases.length).toBeGreaterThanOrEqual(7)
    for (const { name, body: method } of cases) {
      expect(/this\.#(?:target|project)\(|this\.#h\.plan\(/.test(method), name).toBe(true)
    }
    for (const gate of ['#target', '#project']) {
      const method = all.find((m) => m.name === gate)?.body ?? ''
      expect(method, gate).toContain('this.#h.admit(')
      expect(method, gate).toContain('this.#h.authorize(')
    }
  })
})

describe('QueryUseCases', () => {
  const text = readFileSync(new URL('../src/queries.ts', import.meta.url), 'utf8')
  const body = text.slice(text.indexOf('export class QueryUseCases {'))
  const header = /^ {2}(?:async )?(#?[a-zA-Z][a-zA-Z0-9]*)(?:<[^>]*>)?\(/gm
  const starts = [...body.matchAll(header)]
  const all = starts.map((m, i) => ({
    name: m[1] ?? '',
    body: body.slice(m.index, starts[i + 1]?.index ?? body.length),
  }))

  it('every data read authorizes on the resolved target, then applies the data.read rule', () => {
    const cases = all.filter((m) => !m.name.startsWith('#') && m.name !== 'constructor')
    // `history` (Wave 8) reads the audit after the same authorization on the resolved target.
    expect(cases.map((c) => c.name).sort()).toEqual(['cancel', 'explain', 'history', 'run'])
    for (const { name, body: method } of cases) {
      expect(/this\.#(?:target|read)\(/.test(method), name).toBe(true)
    }
    const target = all.find((m) => m.name === '#target')?.body ?? ''
    expect(target).toContain('this.#h.admit(')
    expect(target).toContain('this.#h.authorize(')
    const read = all.find((m) => m.name === '#read')?.body ?? ''
    // The rule before the lane, the audit before the result.
    expect(read.indexOf('this.#policy(')).toBeGreaterThan(read.indexOf('this.#target('))
    expect(read.indexOf('submitDataRead(')).toBeGreaterThan(read.indexOf('this.#policy('))
    expect(read.lastIndexOf('await record(outcome)')).toBeGreaterThan(
      read.indexOf('awaitDataRead('),
    )
  })
})

describe('SavedQueryUseCases', () => {
  const text = readFileSync(new URL('../src/saved-queries.ts', import.meta.url), 'utf8')
  const body = text.slice(text.indexOf('export class SavedQueryUseCases {'))
  const header = /^ {2}(?:async )?(#?[a-zA-Z][a-zA-Z0-9]*)(?:<[^>]*>)?\(/gm
  const starts = [...body.matchAll(header)]
  const all = starts.map((m, i) => ({
    name: m[1] ?? '',
    body: body.slice(m.index, starts[i + 1]?.index ?? body.length),
  }))
  const method = (name: string) => all.find((m) => m.name === name)?.body ?? ''

  it('decides every use case through the engine before it reads or writes a saved query', () => {
    const cases = all.filter((m) => !m.name.startsWith('#') && m.name !== 'constructor')
    expect(cases.map((c) => c.name).sort()).toEqual(['create', 'get', 'list', 'remove', 'update'])
    const list = method('list')
    expect(list.indexOf('this.#h.admit(')).toBeGreaterThan(-1)
    expect(list.indexOf('this.#h.admit(')).toBeLessThan(list.indexOf('FROM savedq.saved_queries'))
    // Each listed row is shown only if the engine allows its scope.
    expect(list.indexOf('this.#h.allowed(')).toBeGreaterThan(list.indexOf('for (const row'))
    const get = method('get')
    expect(get.indexOf('this.#h.admit(')).toBeGreaterThan(-1)
    expect(get.indexOf('this.#h.admit(')).toBeLessThan(get.indexOf('this.#load('))
    expect(get).toContain('this.#visible(')
    // A change is a self-service action of the caller, then owner-checked (and again in the store).
    const create = method('create')
    expect(create.indexOf("'saved_query.create'")).toBeGreaterThan(-1)
    expect(create.indexOf("kind: 'self'")).toBeLessThan(create.indexOf('INSERT INTO'))
    const owned = method('#owned')
    expect(owned.indexOf("kind: 'self'")).toBeLessThan(owned.indexOf('this.#load('))
    expect(owned).toContain('saved.owner !== identityId')
    expect(method('update').indexOf('this.#owned(')).toBeLessThan(
      method('update').indexOf('savedq.update_saved_query'),
    )
    expect(method('remove').indexOf('this.#owned(')).toBeLessThan(
      method('remove').indexOf('savedq.delete_saved_query'),
    )
    // The audit of a change never names the text or the name.
    const audit = method('#audit')
    expect(audit).toContain('sqlDigest')
    expect(audit).not.toMatch(/\bsql:|\bname:|sql_text/)
  })
})

describe('ProfileUseCases', () => {
  const text = readFileSync(new URL('../src/profiles.ts', import.meta.url), 'utf8')
  const body = text.slice(text.indexOf('export class ProfileUseCases {'))
  const header = /^ {2}(?:async )?(#?[a-zA-Z][a-zA-Z0-9]*)(?:<[^>]*>)?\(/gm
  const starts = [...body.matchAll(header)]
  const all = starts.map((m, i) => ({
    name: m[1] ?? '',
    body: body.slice(m.index, starts[i + 1]?.index ?? body.length),
  }))
  const method = (name: string) => all.find((m) => m.name === name)?.body ?? ''

  it('decides every use case through the engine before it reads or writes a profile', () => {
    const cases = all.filter((m) => !m.name.startsWith('#') && m.name !== 'constructor')
    expect(cases.map((c) => c.name).sort()).toEqual([
      'avatar',
      'deleteAvatar',
      'setAvatar',
      'updateProfile',
    ])
    // The changes are self-service actions of the caller's own identity.
    expect(method('#self')).toContain("kind: 'self'")
    expect(method('#self')).toContain('this.#h.authorize(')
    for (const [name, fn] of [
      ['updateProfile', 'profiles.set_display_name'],
      ['setAvatar', 'profiles.set_avatar'],
      ['deleteAvatar', 'profiles.clear_avatar'],
    ] as const) {
      const m = method(name)
      expect(m.indexOf('this.#self('), name).toBeGreaterThan(-1)
      expect(m.indexOf('this.#self('), name).toBeLessThan(m.indexOf(fn))
    }
    // The picture is authorized before its bytes are looked at.
    const set = method('setAvatar')
    expect(set.indexOf('this.#self(')).toBeLessThan(set.indexOf('checkAvatarImage('))
    // A picture is read only after the engine allowed the own read or access.read.
    const read = method('avatar')
    expect(read.indexOf("'identity.avatar.get'")).toBeLessThan(read.indexOf('FROM profiles'))
    expect(read.indexOf("'me.get'")).toBeLessThan(read.indexOf('FROM profiles'))
    // The audit records whether a name is set, never the name; never the bytes.
    expect(method('updateProfile')).toContain('displayNameSet:')
    expect(method('updateProfile')).not.toMatch(/displayName: body/)
    expect(method('#audit')).not.toMatch(/display_?[nN]ame|upload/)
  })
})

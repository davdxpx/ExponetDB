import {
  type EntityId,
  type IdPrefix,
  isId,
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '@exponetdb/kernel'
import type { PlanRecord } from '@exponetdb/operations'

/**
 * Reading a stored plan body back. A plan body is canonical JSON whose hash
 * the database checked; the kinds still re-check every member they use
 * (types, id prefixes), and a member that is missing or of the wrong type
 * makes the plan unusable (`PLAN_STALE` on binding `content`), never a
 * guess.
 */
export class ContentInvalid extends Error {
  override readonly name = 'ContentInvalid'
  readonly member: string
  constructor(member: string) {
    super(`The plan content member ${member} is missing or malformed.`)
    this.member = member
  }
}

export class Body {
  readonly #value: JsonObject
  readonly #path: string

  constructor(value: JsonValue | undefined, path = 'content') {
    if (!isJsonObject(value)) {
      throw new ContentInvalid(path)
    }
    this.#value = value
    this.#path = path
  }

  static content(plan: PlanRecord): Body {
    return new Body(plan.body['content'], 'content')
  }

  static expected(plan: PlanRecord): Body {
    return new Body(plan.body['expectedState'], 'expectedState')
  }

  has(key: string): boolean {
    return this.#value[key] !== undefined
  }

  raw(key: string): JsonValue | undefined {
    return this.#value[key]
  }

  text(key: string): string {
    const v = this.#value[key]
    if (typeof v !== 'string') throw new ContentInvalid(`${this.#path}.${key}`)
    return v
  }

  textOrNull(key: string): string | null {
    const v = this.#value[key]
    if (v === null || v === undefined) return null
    if (typeof v !== 'string') throw new ContentInvalid(`${this.#path}.${key}`)
    return v
  }

  int(key: string): number {
    const v = this.#value[key]
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
      throw new ContentInvalid(`${this.#path}.${key}`)
    }
    return v
  }

  intOrNull(key: string): number | null {
    const v = this.#value[key]
    if (v === null || v === undefined) return null
    return this.int(key)
  }

  bool(key: string): boolean {
    const v = this.#value[key]
    if (typeof v !== 'boolean') throw new ContentInvalid(`${this.#path}.${key}`)
    return v
  }

  id<P extends IdPrefix>(prefix: P, key: string): EntityId<P> {
    const v = this.#value[key]
    if (!isId(prefix, v)) throw new ContentInvalid(`${this.#path}.${key}`)
    return v
  }

  idOrNull<P extends IdPrefix>(prefix: P, key: string): EntityId<P> | null {
    const v = this.#value[key]
    if (v === null || v === undefined) return null
    return this.id(prefix, key)
  }

  oneOf<T extends string>(values: readonly T[], key: string): T {
    const v = this.#value[key]
    const found = values.find((x) => x === v)
    if (found === undefined) throw new ContentInvalid(`${this.#path}.${key}`)
    return found
  }

  object(key: string): Body {
    return new Body(this.#value[key], `${this.#path}.${key}`)
  }

  objectOrNull(key: string): Body | null {
    const v = this.#value[key]
    return v === null || v === undefined ? null : this.object(key)
  }

  list(key: string): Body[] {
    const v = this.#value[key]
    if (!isJsonArray(v)) throw new ContentInvalid(`${this.#path}.${key}`)
    return v.map((item, i) => new Body(item, `${this.#path}.${key}[${i}]`))
  }

  strings(key: string): string[] {
    const v = this.#value[key]
    if (!isJsonArray(v) || !v.every((s) => typeof s === 'string')) {
      throw new ContentInvalid(`${this.#path}.${key}`)
    }
    return v as string[]
  }

  stringsOrNull(key: string): string[] | null {
    const v = this.#value[key]
    if (v === null || v === undefined) return null
    return this.strings(key)
  }

  json(): JsonObject {
    return this.#value
  }
}

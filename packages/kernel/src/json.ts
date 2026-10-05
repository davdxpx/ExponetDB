import { err, ok, type Result } from './result.ts'

export type JsonPrimitive = null | boolean | number | string
export type JsonArray = readonly JsonValue[]
export interface JsonObject {
  readonly [member: string]: JsonValue
}
export type JsonValue = JsonPrimitive | JsonArray | JsonObject

/**
 * Why JSON text or a value is not I-JSON (RFC 7493). Codes are stable: the Go
 * conformance implementation reports the same ones.
 */
export type JsonRefusal =
  | 'invalid_json'
  | 'duplicate_member'
  | 'lone_surrogate'
  | 'number_not_finite'
  | 'nesting_too_deep'
  | 'not_json'

export interface JsonError {
  readonly code: JsonRefusal
  /** Character offset in the input text, when parsing. */
  readonly offset?: number
}

const MAX_DEPTH = 256

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses JSON text strictly: RFC 8259 grammar, no duplicate member names (after
 * unescaping), no lone surrogates, only finite numbers, nesting depth at most
 * 256. Member names such as `__proto__` become ordinary own properties.
 */
export function parseJson(text: string): Result<JsonValue, JsonError> {
  if (!text.isWellFormed()) {
    return err({ code: 'lone_surrogate' })
  }
  const parser = new StrictJsonParser(text)
  try {
    parser.skipWhitespace()
    const value = parser.parseValue(0)
    parser.skipWhitespace()
    if (!parser.atEnd()) {
      return err({ code: 'invalid_json', offset: parser.position })
    }
    return ok(value)
  } catch (e) {
    if (e instanceof JsonParseError) {
      return err({ code: e.code, offset: e.offset })
    }
    throw e
  }
}

/**
 * Checks that an in-memory value is I-JSON: plain objects and arrays, finite
 * numbers, well-formed strings, no cycles, depth at most 256.
 */
export function toJsonValue(value: unknown): Result<JsonValue, JsonError> {
  const code = checkJson(value, 0, new Set())
  return passed(value, code) ? ok(value) : err({ code: code ?? 'not_json' })
}

export function isJsonValue(value: unknown): value is JsonValue {
  return checkJson(value, 0, new Set()) === undefined
}

function passed(_value: unknown, code: JsonRefusal | undefined): _value is JsonValue {
  return code === undefined
}

export function isJsonArray(value: JsonValue | undefined): value is JsonArray {
  return Array.isArray(value)
}

function checkJson(value: unknown, depth: number, seen: Set<object>): JsonRefusal | undefined {
  if (value === null || typeof value === 'boolean') {
    return undefined
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : 'number_not_finite'
  }
  if (typeof value === 'string') {
    return value.isWellFormed() ? undefined : 'lone_surrogate'
  }
  if (typeof value !== 'object') {
    return 'not_json'
  }
  if (depth >= MAX_DEPTH) {
    return 'nesting_too_deep'
  }
  if (seen.has(value)) {
    return 'not_json'
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        const code = checkJson(item, depth + 1, seen)
        if (code !== undefined) {
          return code
        }
      }
      return undefined
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      return 'not_json'
    }
    for (const key of Object.keys(value)) {
      if (!key.isWellFormed()) {
        return 'lone_surrogate'
      }
      const member: unknown = Reflect.get(value, key)
      const code = checkJson(member, depth + 1, seen)
      if (code !== undefined) {
        return code
      }
    }
    return Object.getOwnPropertySymbols(value).length === 0 ? undefined : 'not_json'
  } finally {
    seen.delete(value)
  }
}

class JsonParseError extends Error {
  readonly code: JsonRefusal
  readonly offset: number

  constructor(code: JsonRefusal, offset: number) {
    super(code)
    this.code = code
    this.offset = offset
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y

class StrictJsonParser {
  position = 0
  private readonly text: string

  constructor(text: string) {
    this.text = text
  }

  atEnd(): boolean {
    return this.position >= this.text.length
  }

  skipWhitespace(): void {
    while (this.position < this.text.length) {
      const c = this.text.charCodeAt(this.position)
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        this.position++
      } else {
        return
      }
    }
  }

  private fail(code: JsonRefusal = 'invalid_json'): never {
    throw new JsonParseError(code, this.position)
  }

  private expectLiteral(literal: string): void {
    if (this.text.startsWith(literal, this.position)) {
      this.position += literal.length
    } else {
      this.fail()
    }
  }

  parseValue(depth: number): JsonValue {
    if (depth > MAX_DEPTH) {
      this.fail('nesting_too_deep')
    }
    const c = this.text[this.position]
    switch (c) {
      case '{':
        return this.parseObject(depth)
      case '[':
        return this.parseArray(depth)
      case '"':
        return this.parseString()
      case 't':
        this.expectLiteral('true')
        return true
      case 'f':
        this.expectLiteral('false')
        return false
      case 'n':
        this.expectLiteral('null')
        return null
      default:
        return this.parseNumber()
    }
  }

  private parseNumber(): number {
    NUMBER.lastIndex = this.position
    const match = NUMBER.exec(this.text)
    if (match === null || match[0].length === 0) {
      this.fail()
    }
    const value = Number(match[0])
    if (!Number.isFinite(value)) {
      this.fail('number_not_finite')
    }
    this.position += match[0].length
    return value
  }

  private parseArray(depth: number): JsonValue[] {
    this.position++
    const items: JsonValue[] = []
    this.skipWhitespace()
    if (this.text[this.position] === ']') {
      this.position++
      return items
    }
    for (;;) {
      this.skipWhitespace()
      items.push(this.parseValue(depth + 1))
      this.skipWhitespace()
      const c = this.text[this.position]
      if (c === ',') {
        this.position++
      } else if (c === ']') {
        this.position++
        return items
      } else {
        this.fail()
      }
    }
  }

  private parseObject(depth: number): JsonObject {
    this.position++
    const object: Record<string, JsonValue> = {}
    const names = new Set<string>()
    this.skipWhitespace()
    if (this.text[this.position] === '}') {
      this.position++
      return object
    }
    for (;;) {
      this.skipWhitespace()
      if (this.text[this.position] !== '"') {
        this.fail()
      }
      const nameOffset = this.position
      const name = this.parseString()
      if (names.has(name)) {
        throw new JsonParseError('duplicate_member', nameOffset)
      }
      names.add(name)
      this.skipWhitespace()
      if (this.text[this.position] !== ':') {
        this.fail()
      }
      this.position++
      this.skipWhitespace()
      const value = this.parseValue(depth + 1)
      // defineProperty keeps "__proto__" an ordinary member instead of
      // invoking the prototype setter.
      Object.defineProperty(object, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      })
      this.skipWhitespace()
      const c = this.text[this.position]
      if (c === ',') {
        this.position++
      } else if (c === '}') {
        this.position++
        return object
      } else {
        this.fail()
      }
    }
  }

  private parseString(): string {
    this.position++
    let out = ''
    for (;;) {
      if (this.position >= this.text.length) {
        this.fail()
      }
      const code = this.text.charCodeAt(this.position)
      if (code === 0x22) {
        this.position++
        return out
      }
      if (code < 0x20) {
        this.fail()
      }
      if (code !== 0x5c) {
        out += this.text[this.position]
        this.position++
        continue
      }
      const escaped = this.text[this.position + 1]
      switch (escaped) {
        case '"':
        case '\\':
        case '/':
          out += escaped
          this.position += 2
          break
        case 'b':
          out += '\b'
          this.position += 2
          break
        case 'f':
          out += '\f'
          this.position += 2
          break
        case 'n':
          out += '\n'
          this.position += 2
          break
        case 'r':
          out += '\r'
          this.position += 2
          break
        case 't':
          out += '\t'
          this.position += 2
          break
        case 'u':
          out += this.parseUnicodeEscape()
          break
        default:
          this.fail()
      }
    }
  }

  private readHex4(at: number): number | undefined {
    const hex = this.text.slice(at, at + 4)
    return /^[0-9A-Fa-f]{4}$/.test(hex) ? Number.parseInt(hex, 16) : undefined
  }

  /** Reads `\uXXXX`, pairing surrogates; a lone surrogate is refused. */
  private parseUnicodeEscape(): string {
    const unit = this.readHex4(this.position + 2)
    if (unit === undefined) {
      this.fail()
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      this.fail('lone_surrogate')
    }
    if (unit < 0xd800 || unit > 0xdbff) {
      this.position += 6
      return String.fromCharCode(unit)
    }
    const low = this.text.startsWith('\\u', this.position + 6)
      ? this.readHex4(this.position + 8)
      : undefined
    if (low === undefined || low < 0xdc00 || low > 0xdfff) {
      this.fail('lone_surrogate')
    }
    this.position += 12
    return String.fromCharCode(unit, low)
  }
}

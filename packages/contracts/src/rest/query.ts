import { z } from 'zod'

const INTEGER = /^(0|-?[1-9][0-9]{0,14})$/

/** The declared type of a query parameter, through `optional` and `default`. */
function declared(schema: z.core.$ZodType): 'number' | 'boolean' | 'other' {
  let current: z.core.$ZodType = schema
  for (let depth = 0; depth < 4; depth++) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      current = current.unwrap()
      continue
    }
    break
  }
  if (current instanceof z.ZodNumber) {
    return 'number'
  }
  return current instanceof z.ZodBoolean ? 'boolean' : 'other'
}

/**
 * Decodes the query string of a request into the types its route declares
 * (OpenAPI `in: query`, form style): an integer parameter from its decimal
 * text, a boolean from `true` or `false`. Anything else stays text, so the
 * route's schema refuses it (`VALIDATION_FAILED`); nothing is guessed from
 * the value alone and unknown parameters are kept for the schema to refuse.
 */
export function decodeQuery(
  schema: z.ZodObject,
  raw: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const shape: Readonly<Record<string, z.ZodType>> = schema.shape
  const decoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const member = Object.hasOwn(shape, key) ? shape[key] : undefined
    const type = member === undefined ? 'other' : declared(member)
    if (type === 'number' && INTEGER.test(value)) {
      decoded[key] = Number(value)
    } else if (type === 'boolean' && (value === 'true' || value === 'false')) {
      decoded[key] = value === 'true'
    } else {
      decoded[key] = value
    }
  }
  return decoded
}

import { idPattern } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import {
  contractJsonSchema,
  MigrationIdSchema,
  TargetIdSchema,
  untrustedText,
} from '../src/index.ts'

describe('contract JSON Schema', () => {
  it('emits the kernel pattern for ids and no internal metadata', () => {
    const schema = contractJsonSchema(
      z.strictObject({ target: TargetIdSchema, migration: MigrationIdSchema }),
      { io: 'input' },
    )
    const props = schema['properties'] as Record<string, Record<string, unknown>>
    expect(props['target']).toMatchObject({ type: 'string', pattern: idPattern('tgt') })
    expect(props['migration']).toMatchObject({
      type: 'string',
      pattern: '^[0-7][0-9A-HJKMNP-TV-Z]{25}$',
    })
    expect(JSON.stringify(schema)).not.toContain('exponetdbIdPrefix')
  })

  it('validates ids with the kernel rule (no case folding)', () => {
    expect(TargetIdSchema.safeParse('tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z').success).toBe(true)
    expect(TargetIdSchema.safeParse('tgt_01jb2z6g8m4q7r9t1v3w5x7y9z').success).toBe(false)
    expect(TargetIdSchema.safeParse('pln_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z').success).toBe(false)
  })

  it('carries the untrusted annotation', () => {
    const schema = contractJsonSchema(z.object({ comment: untrustedText(10, 'x') }), {
      io: 'input',
    })
    expect((schema['properties'] as Record<string, unknown>)['comment']).toMatchObject({
      untrusted: true,
    })
  })

  it('refuses schemas that cannot be represented', () => {
    expect(() =>
      contractJsonSchema(
        z.custom<string>(() => true),
        { io: 'input' },
      ),
    ).toThrow()
    expect(() =>
      contractJsonSchema(
        z.string().transform((s) => s.length),
        { io: 'output' },
      ),
    ).toThrow()
    expect(() => contractJsonSchema(z.date(), { io: 'input' })).toThrow()
  })

  it('keeps response objects open in input mode and request objects closed', () => {
    expect(
      contractJsonSchema(z.object({ a: z.string() }), { io: 'input' })['additionalProperties'],
    ).toBeUndefined()
    expect(
      contractJsonSchema(z.strictObject({ a: z.string() }), { io: 'input' })[
        'additionalProperties'
      ],
    ).toBe(false)
  })
})

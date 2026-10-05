import { InvariantError, idPattern, isIdPrefix, MIGRATION_ID_PATTERN } from '@exponetdb/kernel'
import * as z from 'zod'

export type JsonSchema = Record<string, unknown>

export interface ContractJsonSchemaOptions {
  /**
   * `input`: what a sender must produce (requests, manifests, protocol
   * messages). `output`: what a receiver can rely on. Open response objects
   * (z.object) stay open in `input` mode, which is how clients read them.
   */
  readonly io: 'input' | 'output'
}

/**
 * JSON Schema 2020-12 for a contract schema. Ids are emitted with the
 * kernel's own pattern; anything Zod cannot represent is a programming error
 * (no silent `{}` schemas). Used by the generators and later by the MCP
 * server for tool schemas, so both publish the same thing.
 */
export function contractJsonSchema(
  schema: z.ZodType,
  options: ContractJsonSchemaOptions,
): JsonSchema {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: options.io,
    unrepresentable: 'any',
    override: (ctx) => {
      const meta = z.globalRegistry.get(ctx.zodSchema)
      const def = ctx.zodSchema._zod.def
      const prefix = meta?.['exponetdbIdPrefix']
      if (typeof prefix === 'string') {
        if (!isIdPrefix(prefix)) {
          throw new InvariantError(`unknown id prefix in schema metadata: ${prefix}`)
        }
        delete ctx.jsonSchema['exponetdbIdPrefix']
        ctx.jsonSchema['type'] = 'string'
        ctx.jsonSchema['pattern'] = idPattern(prefix)
        return
      }
      if (meta?.['exponetdbMigrationId'] === true) {
        delete ctx.jsonSchema['exponetdbMigrationId']
        ctx.jsonSchema['type'] = 'string'
        ctx.jsonSchema['pattern'] = MIGRATION_ID_PATTERN
        return
      }
      if (UNREPRESENTABLE.has(def.type)) {
        throw new InvariantError(`contract schema is not representable in JSON Schema: ${def.type}`)
      }
    },
  })
}

const UNREPRESENTABLE: ReadonlySet<string> = new Set([
  'custom',
  'transform',
  'bigint',
  'symbol',
  'undefined',
  'void',
  'date',
  'map',
  'set',
  'function',
  'promise',
  'nan',
])

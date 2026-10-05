import type { JsonValue } from '@exponetdb/kernel'
import type { PolicyRequest } from './model.ts'

/**
 * Fact providers ([policy-engine.md §6](../../../exponetdb-docs/02-control-plane/policy-engine.md#6-hooks)).
 * Rules never query tables; they declare the providers they need and receive
 * typed facts. A provider that is not registered, fails, or cannot tell
 * yields `unknown`, which fails closed.
 */
export const FACT_NAMES = [
  'evidence',
  'ledger',
  'backups',
  'windows',
  'analysis',
  'principal',
  'target',
] as const
export type FactName = (typeof FACT_NAMES)[number]

export type Fact =
  | { readonly status: 'known'; readonly value: JsonValue }
  | { readonly status: 'unknown'; readonly reason: string }

export interface FactProvider {
  readonly name: FactName
  load(request: PolicyRequest): Promise<Fact>
}

export type Facts = Readonly<Partial<Record<FactName, JsonValue>>>

/** The `principal` provider: facts established by authentication, carried in the request. */
export const principalFacts: FactProvider = {
  name: 'principal',
  async load(request) {
    const p = request.principal
    return {
      status: 'known',
      value: {
        kind: p.kind,
        identityId: p.identityId,
        client: p.client,
        agent: p.client === 'mcp',
        reauthAt: p.reauthAt ?? null,
      },
    }
  },
}

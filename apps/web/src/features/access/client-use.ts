import { type Grant, lastUseLabel } from './people-model.ts'

/**
 * What the OAuth clients page can say about a client's use until the server
 * reports it on the client itself: the latest recorded use and the number of
 * active grants, aggregated from `GET /grants` (all states). The aggregate is
 * only as complete as the grants that were read, and the page says so: a
 * client with no grant in the read has no use in it, and a grant without a
 * recorded use is not evidence that the client was never used (the record of
 * a grant's use began with its deployment and a background write can be lost).
 */
export interface ClientUse {
  /** The most recent `lastUsedAt` of any grant of the client, or null when no grant has one. */
  readonly lastUsedAt: string | null
  /** How that use came in (the class of the grant that holds the latest use). */
  readonly lastUseClass: Grant['lastUseClass']
  readonly activeGrants: number
}

interface Accumulator {
  lastUsedAt: string | null
  lastUseClass: Grant['lastUseClass']
  activeGrants: number
}

/** Use per client, keyed by the client's own ID (`cli_…`, the grant's `client.id`). */
export function clientUse(grants: readonly Grant[]): ReadonlyMap<string, ClientUse> {
  const byClient = new Map<string, Accumulator>()
  for (const grant of grants) {
    const entry = byClient.get(grant.client.id) ?? {
      lastUsedAt: null,
      lastUseClass: null,
      activeGrants: 0,
    }
    if (grant.state === 'active') entry.activeGrants += 1
    const at = grant.lastUsedAt ?? null
    if (
      at !== null &&
      (entry.lastUsedAt === null || Date.parse(at) > Date.parse(entry.lastUsedAt))
    ) {
      entry.lastUsedAt = at
      entry.lastUseClass = grant.lastUseClass ?? null
    }
    byClient.set(grant.client.id, entry)
  }
  return byClient
}

/** The class of the latest use as words, or undefined when none is recorded. */
export function lastUseClassText(use: ClientUse): string | undefined {
  return use.lastUseClass === null || use.lastUseClass === undefined
    ? undefined
    : lastUseLabel(use.lastUseClass)
}

/**
 * The grants read as the client cards need it. `partial` is true when the
 * server has more grants than were read; `stale` when the read is an earlier
 * one. A failed read carries its reason and says nothing about use.
 */
export type ClientUseRead =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly reason: string }
  | {
      readonly state: 'ready'
      readonly byClient: ReadonlyMap<string, ClientUse>
      readonly partial: boolean
      readonly stale: boolean
    }

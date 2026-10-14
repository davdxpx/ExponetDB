import type { Environment } from './keys.ts'

/**
 * The environments of a product in promotion order and their evidence chain
 * (migrations/evidence: a change reaches an environment only with verified
 * evidence from the environment it names). Pure functions over what the
 * server sent; a reference to a slug that is not in the list is kept as the
 * slug it is, and a loop ends the chain where it would repeat.
 */
export function byRank(environments: readonly Environment[]): Environment[] {
  return [...environments].sort((a, b) => a.rank - b.rank || a.slug.localeCompare(b.slug))
}

/**
 * Every evidence chain of the product, earliest environment first
 * (`development → staging → production`): one per environment that no other
 * environment takes evidence from. An environment alone in its chain is left out.
 */
export function evidenceChains(environments: readonly Environment[]): string[][] {
  const bySlug = new Map(environments.map((environment) => [environment.slug, environment]))
  const referenced = new Set(
    environments.flatMap((environment) =>
      environment.evidenceFrom === null ? [] : [environment.evidenceFrom],
    ),
  )
  const chains: string[][] = []
  for (const environment of byRank(environments)) {
    if (referenced.has(environment.slug)) continue
    const chain = [environment.slug]
    let from = environment.evidenceFrom
    while (from !== null && !chain.includes(from)) {
      chain.unshift(from)
      from = bySlug.get(from)?.evidenceFrom ?? null
    }
    if (chain.length > 1) chains.push(chain)
  }
  return chains
}

export interface EnvironmentDraft {
  displayName: string
  tier: 'prod' | 'nonprod'
  evidenceFrom: string
  rank: string
}

export function draftOf(environment: Environment): EnvironmentDraft {
  return {
    displayName: environment.displayName,
    tier: environment.tier,
    evidenceFrom: environment.evidenceFrom ?? '',
    rank: String(environment.rank),
  }
}

/** Whether a typed rank is a whole number from 0 to 1000. */
export function validRank(text: string): boolean {
  const trimmed = text.trim()
  return /^\d{1,4}$/.test(trimmed) && Number(trimmed) <= 1000
}

/** The fields of a change request that differ from the environment (an empty object means no change). */
export function changeOf(
  environment: Environment,
  draft: EnvironmentDraft,
): {
  displayName?: string
  tier?: 'prod' | 'nonprod'
  evidenceFrom?: string | null
  rank?: number
} {
  const name = draft.displayName.trim()
  const evidence = draft.evidenceFrom === '' ? null : draft.evidenceFrom
  const rank = Number(draft.rank.trim())
  return {
    ...(name === environment.displayName ? {} : { displayName: name }),
    ...(draft.tier === environment.tier ? {} : { tier: draft.tier }),
    ...(evidence === environment.evidenceFrom ? {} : { evidenceFrom: evidence }),
    ...(rank === environment.rank ? {} : { rank }),
  }
}

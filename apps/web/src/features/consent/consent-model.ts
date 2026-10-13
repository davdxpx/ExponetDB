import type { ConsentView, Scope, TargetRestriction, Tier } from '@exponetdb/contracts'

/**
 * The consent decision as data (oauth.md §4; Wave 3B, Wave 7): what a
 * client asks for, the warnings a person needs to tell a real request from
 * a lookalike, and the exact choice sent to the server. The server decides
 * again when the choice arrives; this module only shapes what the page
 * offers and refuses to send anything the view did not offer.
 */
export type Effect = ConsentView['scopes'][number]['effect']

/** What a scope lets the application do, from the action contracts (never from its name). */
export const EFFECT_LABEL: Readonly<Record<Effect, string>> = {
  read: 'Reads',
  control_record: 'Records plans or checks, changes nothing',
  consequential: 'Changes',
}

export interface ConsentChoice {
  readonly scopes: ReadonlySet<string>
  readonly tiers: ReadonlySet<Tier>
  /** The person ticked "I allow access to production". */
  readonly production: boolean
  readonly where: 'all' | 'list'
  readonly targets: ReadonlySet<string>
  readonly lifetimeDays: number
}

export interface ConsentDecision {
  readonly decision: 'allow' | 'deny'
  readonly scopes: Scope[]
  readonly tiers: Tier[]
  readonly lifetimeDays: number
  readonly acknowledgeProduction?: true
  readonly targets?: TargetRestriction
}

/** The preselection: available scopes that need no explicit consent, the server's default tiers. */
export function initialChoice(view: ConsentView): ConsentChoice {
  return {
    scopes: new Set(
      view.scopes.filter((o) => o.available && !o.explicitConsent).map((o) => o.scope),
    ),
    tiers: new Set(view.defaults.tiers),
    production: false,
    where: 'all',
    targets: new Set(),
    lifetimeDays: view.lifetimeDays.default,
  }
}

export interface ConsentWarnings {
  /** The name resembles a first-party client but the client is not one. */
  readonly lookalike: boolean
  /** The client's own name is shown with "name not verified". */
  readonly nameUnverified: boolean
  /**
   * The lethal trifecta (threat model, Wave 7): an MCP client asking to read
   * production rows and to change databases at once.
   */
  readonly trifecta: boolean
}

export function consentWarnings(view: ConsentView): ConsentWarnings {
  const offered = view.scopes
  return {
    lookalike: view.client.lookalike,
    nameUnverified: !view.client.firstParty,
    trifecta:
      view.resource === 'mcp' &&
      offered.some((o) => o.available && o.scope === 'data.read:prod') &&
      offered.some((o) => o.available && o.effect === 'consequential'),
  }
}

/** Offered scopes grouped by what they do, in the order read, records, changes. */
export function scopesByEffect(
  view: ConsentView,
): { effect: Effect; offers: ConsentView['scopes'] }[] {
  const order: Effect[] = ['read', 'control_record', 'consequential']
  return order
    .map((effect) => ({ effect, offers: view.scopes.filter((o) => o.effect === effect) }))
    .filter((group) => group.offers.length > 0)
}

/** Whether the choice reaches production, so the explicit acknowledgement is needed. */
export function reachesProduction(view: ConsentView, choice: ConsentChoice): boolean {
  return (
    choice.tiers.has('prod') ||
    view.scopes.some((o) => o.tier === 'prod' && choice.scopes.has(o.scope))
  )
}

/**
 * The request body for a decision: only offered and available scopes, only
 * the two tiers, a lifetime within the server's bounds (else its default),
 * the production acknowledgement only when the person gave it, and a target
 * list only when the person chose "only these" and allowed (every target one
 * the view listed). A denial sends nothing but the decision's shape.
 */
export function toDecision(
  view: ConsentView,
  choice: ConsentChoice,
  decision: 'allow' | 'deny',
): ConsentDecision {
  const scopes = view.scopes
    .filter((o) => o.available && choice.scopes.has(o.scope))
    .map((o) => o.scope)
  const tiers = (['nonprod', 'prod'] as const).filter((t) => choice.tiers.has(t))
  const days =
    Number.isInteger(choice.lifetimeDays) &&
    choice.lifetimeDays >= 1 &&
    choice.lifetimeDays <= view.lifetimeDays.max
      ? choice.lifetimeDays
      : view.lifetimeDays.default
  const listed = view.targets.filter((t) => choice.targets.has(t.id)).map((t) => t.id)
  return {
    decision,
    scopes: decision === 'allow' ? scopes : [],
    tiers: decision === 'allow' ? tiers : [],
    lifetimeDays: days,
    ...(decision === 'allow' && choice.production ? { acknowledgeProduction: true as const } : {}),
    ...(decision === 'allow' && choice.where === 'list'
      ? { targets: { kind: 'list' as const, targetIds: listed } }
      : {}),
  }
}

/** Why "Authorize" cannot be pressed yet, or undefined when it can. */
export function allowBlocker(view: ConsentView, choice: ConsentChoice): string | undefined {
  if (toDecision(view, choice, 'allow').scopes.length === 0) {
    return 'Choose at least one permission.'
  }
  if (choice.tiers.size === 0) {
    return 'Choose where the application may act.'
  }
  if (reachesProduction(view, choice) && !choice.production) {
    return 'Confirm that you allow access to production.'
  }
  if (choice.where === 'list' && toDecision(view, choice, 'allow').targets?.kind === 'list') {
    const restriction = toDecision(view, choice, 'allow').targets
    if (restriction?.kind === 'list' && restriction.targetIds.length === 0) {
      return 'Choose at least one target, or allow every target of the chosen kinds.'
    }
  }
  return undefined
}

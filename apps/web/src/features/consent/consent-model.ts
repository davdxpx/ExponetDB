import type { ConsentView, Scope, TargetRestriction, Tier } from '@exponetdb/contracts'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'

/**
 * The consent decision as data (oauth.md §4; Wave 3B, Wave 7): what a
 * client asks for, the warnings a person needs to tell a real request from
 * a lookalike, and the exact choice sent to the server. The server decides
 * again when the choice arrives; this module only shapes what the page
 * offers and refuses to send anything the view did not offer.
 */
export type Effect = ConsentView['scopes'][number]['effect']
export type ScopeOffer = ConsentView['scopes'][number]

/** What a scope lets the application do, from the action contracts (never from its name). */
export const EFFECT_MESSAGE: Readonly<Record<Effect, MessageKey>> = {
  read: 'consent.effect.read',
  control_record: 'consent.effect.record',
  consequential: 'consent.effect.change',
}

export function effectLabel(effect: Effect): string {
  return t(EFFECT_MESSAGE[effect])
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

/** The scopes a choice starts with: available ones that need no explicit consent. */
function preselected(view: ConsentView): ConsentView['scopes'] {
  return view.scopes.filter((o) => o.available && !o.explicitConsent)
}

/** The preselection: available scopes that need no explicit consent, the server's default tiers. */
export function initialChoice(view: ConsentView): ConsentChoice {
  return {
    scopes: new Set(preselected(view).map((o) => o.scope)),
    tiers: new Set(view.defaults.tiers),
    production: false,
    where: 'all',
    targets: new Set(),
    lifetimeDays: view.lifetimeDays.default,
  }
}

/** Whether an offer's tier is among the chosen tiers (an offer without a tier always is). */
export function tierChosen(offer: Pick<ScopeOffer, 'tier'>, tiers: ReadonlySet<Tier>): boolean {
  return offer.tier === null || tiers.has(offer.tier)
}

/**
 * The choice after the person switched a tier on or off. Switching a tier
 * off removes the scopes of that tier (a scope of a tier that is not chosen
 * is refused by the server); switching it on again restores only the
 * preselected scopes of that tier, so a production scope is never chosen
 * without its own explicit tick. Targets of a tier that is off are dropped.
 */
export function withTier(
  view: ConsentView,
  choice: ConsentChoice,
  tier: Tier,
  on: boolean,
): ConsentChoice {
  const tiers = new Set(choice.tiers)
  const scopes = new Set(choice.scopes)
  if (on) {
    tiers.add(tier)
    for (const offer of preselected(view)) {
      if (offer.tier === tier) scopes.add(offer.scope)
    }
  } else {
    tiers.delete(tier)
    for (const offer of view.scopes) {
      if (offer.tier === tier) scopes.delete(offer.scope)
    }
  }
  const targets = new Set(
    view.targets.filter((t) => choice.targets.has(t.id) && tiers.has(t.tier)).map((t) => t.id),
  )
  return { ...choice, tiers, scopes, targets }
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
 * Whether the choice grants authority that needs a proof of identity at
 * most `view.reauth.withinSeconds` old (oauth.md §4, threat model T3): a
 * scope that writes and reaches production, or a human-only scope. The
 * server applies the same rule when the choice arrives and answers
 * `REAUTH_REQUIRED`; the page only says it beforehand.
 */
export function needsFreshProof(view: ConsentView, choice: ConsentChoice): boolean {
  const production = choice.tiers.has('prod')
  return view.scopes.some(
    (o) =>
      o.available &&
      choice.scopes.has(o.scope) &&
      o.write &&
      ((production && o.tier !== 'nonprod') || o.humanOnly),
  )
}

/**
 * The request body for a decision: only offered and available scopes of a
 * chosen tier (a scope without a tier always), only the two tiers, a
 * lifetime within the server's bounds (else its default), the production
 * acknowledgement only when the person gave it and the choice reaches
 * production, and a target list only when the person chose "only these"
 * and allowed (every target one the view listed, of a chosen tier). A
 * denial sends nothing but the decision's shape.
 */
export function toDecision(
  view: ConsentView,
  choice: ConsentChoice,
  decision: 'allow' | 'deny',
): ConsentDecision {
  // A scope bound to a tier that is not chosen is never sent (the server refuses it).
  const scopes = view.scopes
    .filter((o) => o.available && choice.scopes.has(o.scope) && tierChosen(o, choice.tiers))
    .map((o) => o.scope)
  const tiers = (['nonprod', 'prod'] as const).filter((t) => choice.tiers.has(t))
  const days =
    Number.isInteger(choice.lifetimeDays) &&
    choice.lifetimeDays >= 1 &&
    choice.lifetimeDays <= view.lifetimeDays.max
      ? choice.lifetimeDays
      : view.lifetimeDays.default
  const listed = view.targets
    .filter((t) => choice.targets.has(t.id) && choice.tiers.has(t.tier))
    .map((t) => t.id)
  const acknowledged = choice.production && reachesProduction(view, choice)
  return {
    decision,
    scopes: decision === 'allow' ? scopes : [],
    tiers: decision === 'allow' ? tiers : [],
    lifetimeDays: days,
    ...(decision === 'allow' && acknowledged ? { acknowledgeProduction: true as const } : {}),
    ...(decision === 'allow' && choice.where === 'list'
      ? { targets: { kind: 'list' as const, targetIds: listed } }
      : {}),
  }
}

/** Why "Authorize" cannot be pressed yet, or undefined when it can. */
export function allowBlocker(view: ConsentView, choice: ConsentChoice): string | undefined {
  const allow = toDecision(view, choice, 'allow')
  // Production first: a production scope ticked before its tier still needs the acknowledgement.
  if (reachesProduction(view, choice) && !choice.production) {
    return t('consent.blocker.production')
  }
  if (allow.scopes.length === 0) {
    return t('consent.blocker.scopes')
  }
  if (choice.tiers.size === 0) {
    return t('consent.blocker.tiers')
  }
  if (allow.targets?.kind === 'list' && allow.targets.targetIds.length === 0) {
    return t('consent.blocker.targets')
  }
  return undefined
}

/**
 * Milliseconds until the request expires on this browser's clock, or
 * undefined when the page should not decide expiry itself: the time is not
 * a date, or the clock says the request has already expired although the
 * server just showed it as open (the clocks disagree; the server decides
 * when the choice arrives).
 */
export function expiryDelay(expiresAt: string, now: number): number | undefined {
  const at = Date.parse(expiresAt)
  if (Number.isNaN(at) || at <= now) return undefined
  return at - now
}

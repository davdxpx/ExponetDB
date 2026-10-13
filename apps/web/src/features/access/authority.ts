import type { Scope, Tier } from '@exponetdb/contracts'
import * as z from 'zod'
import type { Body } from '../../lib/api/client.ts'

/**
 * The authority a person gives a service account, as a machine grant or an
 * API key (identity.md §5): scopes, tiers, a lifetime and, for production
 * write authority, an explicit acknowledgement. A scope is a ceiling, never
 * a permission: the service account can do only what its roles allow, and
 * the server checks every scope again (catalog, client kind, the person's
 * own permissions, tiers). This module only shapes the choice the page
 * offers and the request it sends.
 */
export type ScopeEffect = 'read' | 'control_record' | 'consequential'

export interface MachineScope {
  readonly scope: Scope
  /** What the scope lets the client do, from the action contracts (`scopeEffect`). */
  readonly effect: ScopeEffect
  /** The tier the scope authorizes, or null when it is not tier-dependent. */
  readonly tier: Tier | null
  /** `isWriteScope`: any effect other than a read (it decides the production acknowledgement). */
  readonly write: boolean
}

/**
 * Every scope a client of kind `ci` may hold, in catalog order. Kept equal to
 * the contracts by `test/access/authority.test.ts` (the browser bundle takes
 * types from the contracts, never their runtime).
 */
export const MACHINE_SCOPES = [
  { scope: 'targets.read', effect: 'read', tier: null, write: false },
  { scope: 'schema.read', effect: 'control_record', tier: null, write: true },
  { scope: 'diagnostics.read', effect: 'read', tier: null, write: false },
  { scope: 'data.read:nonprod', effect: 'read', tier: 'nonprod', write: false },
  { scope: 'data.read:prod', effect: 'read', tier: 'prod', write: false },
  { scope: 'migrations.read', effect: 'read', tier: null, write: false },
  { scope: 'migrations.plan', effect: 'control_record', tier: null, write: true },
  { scope: 'migrations.apply:nonprod', effect: 'consequential', tier: 'nonprod', write: true },
  { scope: 'migrations.apply:prod', effect: 'consequential', tier: 'prod', write: true },
  { scope: 'connections.operate:nonprod', effect: 'consequential', tier: 'nonprod', write: true },
  { scope: 'connections.operate:prod', effect: 'consequential', tier: 'prod', write: true },
  { scope: 'backups.read', effect: 'read', tier: null, write: false },
  { scope: 'backups.run', effect: 'consequential', tier: null, write: true },
  { scope: 'restore.plan', effect: 'control_record', tier: null, write: true },
  { scope: 'nodes.read', effect: 'read', tier: null, write: false },
  { scope: 'nodes.plan', effect: 'consequential', tier: null, write: true },
  { scope: 'nodes.operate:nonprod', effect: 'consequential', tier: 'nonprod', write: true },
  { scope: 'nodes.operate:prod', effect: 'consequential', tier: 'prod', write: true },
  { scope: 'audit.read', effect: 'read', tier: null, write: false },
] as const satisfies readonly MachineScope[]

export type MachineScopeId = (typeof MACHINE_SCOPES)[number]['scope']

const SCOPE_IDS = MACHINE_SCOPES.map((entry) => entry.scope)

export function isMachineScope(value: string): value is MachineScopeId {
  return SCOPE_IDS.some((scope) => scope === value)
}

function machineScope(scope: MachineScopeId): MachineScope | undefined {
  return MACHINE_SCOPES.find((entry) => entry.scope === scope)
}

/** The scopes grouped by effect, in the order read, records, changes. */
export function scopesByEffect(): { effect: ScopeEffect; scopes: MachineScope[] }[] {
  const order: ScopeEffect[] = ['read', 'control_record', 'consequential']
  return order.map((effect) => ({
    effect,
    scopes: MACHINE_SCOPES.filter((entry) => entry.effect === effect),
  }))
}

/** The limits of the server (`OAUTH_LIMITS`): both kinds default to 90 days and allow at most 365. */
export const AUTHORITY_DEFAULT_DAYS = 90
export const AUTHORITY_MAX_DAYS = 365

const TIERS = ['nonprod', 'prod'] as const

/** The form's values. `days` is text: the empty field is `''`, never `NaN`. */
export interface AuthorityValues {
  /** Scope names as the form holds them; only known machine scopes are ever sent. */
  scopes: string[]
  tiers: Tier[]
  acknowledgeProduction: boolean
  days: string
  /** The label of an API key (optional); a machine grant has none. */
  label: string
}

export const AUTHORITY_DEFAULTS: AuthorityValues = {
  scopes: ['targets.read'],
  tiers: ['nonprod'],
  acknowledgeProduction: false,
  days: String(AUTHORITY_DEFAULT_DAYS),
  label: '',
}

/**
 * Whether the choice is production write authority (the server's rule): the
 * production tier with a scope that writes and is not limited to
 * non-production. It needs the explicit acknowledgement.
 */
export function isProductionWrite(scopes: readonly string[], tiers: readonly Tier[]): boolean {
  return (
    tiers.includes('prod') &&
    scopes.some((scope) => {
      const entry = isMachineScope(scope) ? machineScope(scope) : undefined
      return entry?.write === true && entry.tier !== 'nonprod'
    })
  )
}

/** Error texts of the schema, filled from the message catalog by the caller. */
export interface AuthorityMessages {
  readonly scopes: string
  readonly tiers: string
  readonly tierOf: (scope: string, tier: Tier) => string
  readonly production: string
  readonly days: string
  readonly label: string
}

/**
 * The schema of the form. It refuses what the server would refuse for sure
 * (no scope, no tier, a tiered scope outside the chosen tiers, production
 * write authority without the acknowledgement, a lifetime outside 1 to 365
 * days, a label with control characters) so the person learns it before any
 * request; the server decides again.
 */
export function authoritySchema(messages: AuthorityMessages) {
  return z
    .object({
      scopes: z.array(z.string()).min(1, messages.scopes),
      tiers: z.array(z.enum(TIERS)).min(1, messages.tiers),
      acknowledgeProduction: z.boolean(),
      days: z.string().refine((text) => {
        const trimmed = text.trim()
        const days = Number(trimmed)
        return /^[0-9]{1,3}$/.test(trimmed) && days >= 1 && days <= AUTHORITY_MAX_DAYS
      }, messages.days),
      label: z
        .string()
        .max(64, messages.label)
        .regex(/^[^\p{Cc}]*$/u, messages.label),
    })
    .superRefine((values, ctx) => {
      for (const scope of values.scopes) {
        const entry = isMachineScope(scope) ? machineScope(scope) : undefined
        if (entry === undefined) {
          ctx.addIssue({ code: 'custom', path: ['scopes'], message: messages.scopes })
        } else if (entry.tier !== null && !values.tiers.includes(entry.tier)) {
          ctx.addIssue({
            code: 'custom',
            path: ['scopes'],
            message: messages.tierOf(entry.scope, entry.tier),
          })
        }
      }
      if (isProductionWrite(values.scopes, values.tiers) && !values.acknowledgeProduction) {
        ctx.addIssue({
          code: 'custom',
          path: ['acknowledgeProduction'],
          message: messages.production,
        })
      }
    })
}

/**
 * The request body of a machine grant: only known scopes, the tiers in a
 * fixed order, every target the roles reach (`all`), and the production
 * acknowledgement only for production write authority the person
 * acknowledged.
 */
export function toGrantRequest(values: AuthorityValues): Body<'createMachineGrant'> {
  const scopes = values.scopes.filter(isMachineScope)
  const tiers = TIERS.filter((tier) => values.tiers.includes(tier))
  return {
    scopes,
    restrictions: { tiers, targets: { kind: 'all' } },
    lifetimeDays: Number(values.days.trim()),
    ...(values.acknowledgeProduction && isProductionWrite(scopes, tiers)
      ? { acknowledgeProductionWrite: true as const }
      : {}),
  }
}

/** The request body of an API key: the grant's authority plus an optional label. */
export function toApiKeyRequest(values: AuthorityValues): Body<'createApiKey'> {
  const label = values.label.trim()
  return { ...toGrantRequest(values), ...(label.length === 0 ? {} : { label }) }
}

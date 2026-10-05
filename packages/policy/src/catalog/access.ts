import { isJsonArray, isJsonObject, type JsonObject, type JsonValue } from '@exponetdb/kernel'
import type { Rule, RuleEvaluation } from '../rules.ts'

/**
 * Access and approval rules of Wave 3A ([policy-engine.md §4](../../../../exponetdb-docs/02-control-plane/policy-engine.md),
 * authorization.md §3.1, §6.1, OD-9). They read the `access` fact, which
 * the auth package computes from the Control Store for the request's
 * content (dependency inversion: this package queries nothing). A missing
 * or malformed fact is `unknown`, which denies.
 *
 * The `access` fact:
 *
 * | Member | Meaning |
 * |---|---|
 * | `actorIsOwner` | the actor holds an active global owner binding |
 * | `targetIsSelf` | the change is about the actor's own identity |
 * | `targetIsOwner` | the identity the change is about holds the owner role |
 * | `roleId` | the role being granted or removed, or null |
 * | `grantsNotHeld` | permissions of that role the actor does not hold at a scope covering the binding |
 * | `activeOwners` | active owners now |
 * | `removesOwner` | the change ends one active owner |
 * | `lowersSafety` | a policy settings change lowers safety (true, false, or null when unknown) |
 */
type AccessFacts = {
  readonly actorIsOwner: boolean
  readonly targetIsSelf: boolean
  readonly targetIsOwner: boolean
  readonly roleId: string | null
  readonly grantsNotHeld: readonly string[]
  readonly activeOwners: number
  readonly removesOwner: boolean
  readonly lowersSafety: boolean | null
}

function accessFacts(value: JsonValue | undefined): AccessFacts | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }
  const {
    actorIsOwner,
    targetIsSelf,
    targetIsOwner,
    roleId,
    grantsNotHeld,
    activeOwners,
    removesOwner,
    lowersSafety,
  } = value
  if (
    typeof actorIsOwner !== 'boolean' ||
    typeof targetIsSelf !== 'boolean' ||
    typeof targetIsOwner !== 'boolean' ||
    (roleId !== null && typeof roleId !== 'string') ||
    !isJsonArray(grantsNotHeld) ||
    !grantsNotHeld.every((g) => typeof g === 'string') ||
    typeof activeOwners !== 'number' ||
    !Number.isSafeInteger(activeOwners) ||
    typeof removesOwner !== 'boolean' ||
    (lowersSafety !== null && typeof lowersSafety !== 'boolean')
  ) {
    return undefined
  }
  return {
    actorIsOwner,
    targetIsSelf,
    targetIsOwner,
    roleId,
    grantsNotHeld: grantsNotHeld.map(String),
    activeOwners,
    removesOwner,
    lowersSafety,
  }
}

const UNKNOWN: RuleEvaluation = {
  result: 'unknown',
  message: 'The access facts are missing or malformed.',
}

const none = () => []

export const accessNoSelfEscalation: Rule = {
  id: 'access.no-self-escalation',
  version: 1,
  description:
    'An identity cannot bind a role to itself, and cannot grant a role with a permission it does not hold at a scope covering the binding.',
  appliesTo: ['access.role_binding.create'],
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: ['access'],
  defaults: {},
  requirements: none,
  evaluate({ facts }) {
    const access = accessFacts(facts.access)
    if (access === undefined) {
      return UNKNOWN
    }
    if (access.targetIsSelf) {
      return {
        result: 'fail',
        message: 'A role binding for oneself is refused; another administrator creates it.',
        facts: { targetIsSelf: true },
      }
    }
    if (access.grantsNotHeld.length > 0) {
      return {
        result: 'fail',
        message: 'The role carries permissions the actor does not hold at a covering scope.',
        facts: { grantsNotHeld: [...access.grantsNotHeld].sort().slice(0, 64) },
      }
    }
    return { result: 'pass', message: 'No escalation.', facts: { grantsNotHeld: [] } }
  },
}

export const accessOwnerOnly: Rule = {
  id: 'access.owner-only',
  version: 1,
  description:
    'Only an owner grants or removes the owner role and disables, enables or erases an owner.',
  appliesTo: [
    'access.role_binding.create',
    'access.role_binding.delete',
    'access.identity.disable',
    'access.identity.enable',
    'access.identity.erase',
  ],
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: ['access'],
  defaults: {},
  requirements: none,
  evaluate({ facts }) {
    const access = accessFacts(facts.access)
    if (access === undefined) {
      return UNKNOWN
    }
    const ownerChange = access.roleId === 'owner' || access.targetIsOwner
    if (!ownerChange) {
      return { result: 'not_applicable', message: 'No owner is affected.' }
    }
    return access.actorIsOwner
      ? { result: 'pass', message: 'An owner changes an owner.', facts: { actorIsOwner: true } }
      : {
          result: 'fail',
          message: 'Only an owner may change the owner role or an owner identity.',
          facts: { actorIsOwner: false },
        }
  },
}

export const accessLastOwner: Rule = {
  id: 'access.last-owner',
  version: 1,
  description:
    'The last active owner cannot be removed, disabled or erased (the Control Store enforces it too, under a lock).',
  appliesTo: ['access.role_binding.delete', 'access.identity.disable', 'access.identity.erase'],
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: ['access'],
  defaults: {},
  requirements: none,
  evaluate({ facts }) {
    const access = accessFacts(facts.access)
    if (access === undefined) {
      return UNKNOWN
    }
    if (!access.removesOwner) {
      return { result: 'not_applicable', message: 'No active owner is removed.' }
    }
    return access.activeOwners > 1
      ? {
          result: 'pass',
          message: 'Another active owner remains.',
          facts: { activeOwners: access.activeOwners },
        }
      : {
          result: 'fail',
          message: 'The change would leave no active owner.',
          facts: { activeOwners: access.activeOwners },
        }
  },
}

export const accessPolicySafety: Rule = {
  id: 'access.policy-safety',
  version: 1,
  description:
    'A policy configuration change that lowers safety, or whose effect is not known to be a tightening, needs an owner.',
  appliesTo: ['access.policy_settings.update'],
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: ['access'],
  defaults: {},
  requirements: none,
  evaluate({ facts }) {
    const access = accessFacts(facts.access)
    if (access === undefined) {
      return UNKNOWN
    }
    if (access.actorIsOwner || access.lowersSafety === false) {
      return {
        result: 'pass',
        message: access.actorIsOwner ? 'An owner changes policy.' : 'The change only tightens.',
        facts: { actorIsOwner: access.actorIsOwner, lowersSafety: access.lowersSafety },
      }
    }
    return {
      result: 'fail',
      message: 'Only an owner may lower safety or make a change whose effect is unknown.',
      facts: { actorIsOwner: false, lowersSafety: access.lowersSafety },
    }
  },
}

function bool(value: JsonValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * OD-9 (resolved 2026-10-05, option a). A human may approve their own plan
 * when `allowed`; the approvals service additionally requires the explicit
 * acknowledgement and, for a `critical` plan, waits `criticalCoolingSeconds`
 * (database clock) and a fresh re-authentication at apply. An agent client
 * never approves (client kind rule of `approval.approve`).
 */
export const approvalSelfApproval: Rule = {
  id: 'approval.self-approval',
  version: 1,
  description:
    'Self-approval of a human-initiated plan is allowed with acknowledgement; a critical one waits a cooling period.',
  appliesTo: ['approval.approve'],
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { allowed: true, criticalCoolingSeconds: 600 },
  requirements: none,
  evaluate({ request, params }) {
    const content: JsonObject | undefined = isJsonObject(request.content)
      ? request.content
      : undefined
    const self = bool(content?.['selfApproval'])
    const allowed = bool(params['allowed'])
    const cooling = params['criticalCoolingSeconds']
    if (
      self === undefined ||
      allowed === undefined ||
      typeof cooling !== 'number' ||
      !Number.isSafeInteger(cooling) ||
      cooling < 0 ||
      cooling > 86_400
    ) {
      return { result: 'unknown', message: 'The approval facts or parameters are malformed.' }
    }
    if (!self) {
      return { result: 'not_applicable', message: 'Not a self-approval.' }
    }
    return allowed
      ? {
          result: 'pass',
          message: 'Self-approval is allowed by policy.',
          facts: { selfApproval: true, criticalCoolingSeconds: cooling },
        }
      : {
          result: 'fail',
          message: 'Self-approval is not allowed by policy; another human must approve.',
          facts: { selfApproval: true },
        }
  },
}

/**
 * Erasing an identity destroys data that cannot be restored, so it needs
 * an approval (with OD-9, the actor may self-approve with acknowledgement,
 * the cooling period and a fresh re-authentication at apply).
 */
export const accessEraseApproval: Rule = {
  id: 'access.erase-approval',
  version: 1,
  description: 'Erasing an identity needs a human approval.',
  appliesTo: ['access.identity.erase'],
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1 },
  requirements(params) {
    const count = params['approvals']
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 1
      ? [{ kind: 'approval', count, permission: 'plans.approve' }]
      : []
  },
  evaluate() {
    return { result: 'fail', message: 'Erasure needs an approval.' }
  },
}

export const ACCESS_RULES: readonly Rule[] = [
  accessNoSelfEscalation,
  accessOwnerOnly,
  accessLastOwner,
  accessPolicySafety,
  accessEraseApproval,
  approvalSelfApproval,
]

/**
 * Whether new parameters of a rule tighten, loosen or have an unknown
 * effect, for the `access.policy-safety` rule. Only parameters whose
 * direction is known here count as tightening; anything else is unknown.
 */
export function lowersSafety(
  ruleId: string,
  before: JsonObject,
  after: JsonObject,
): boolean | null {
  if (ruleId === approvalSelfApproval.id) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    let lowers = false
    for (const key of keys) {
      const was = before[key]
      const now = after[key]
      if (key === 'allowed' && typeof was === 'boolean' && typeof now === 'boolean') {
        lowers ||= !was && now
      } else if (
        key === 'criticalCoolingSeconds' &&
        typeof was === 'number' &&
        typeof now === 'number'
      ) {
        lowers ||= now < was
      } else {
        return null
      }
    }
    return lowers
  }
  return null
}

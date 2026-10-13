import type { Queryable } from '@exponetdb/control-store'
import type { Clock, GrantId, IdentityId, JsonValue, OAuthClientId } from '@exponetdb/kernel'
import { type OperationActor, readPolicySettings } from '@exponetdb/operations'
import {
  type BreakGlass,
  type PolicyDecision,
  PolicyEngine,
  type Principal,
  principalFacts,
  type RuleRegistry,
  type SubjectScope,
} from '@exponetdb/policy'

/**
 * Who plans a registry or node change. For the human-only registry actions,
 * a person through a Web App session or the first-party CLI (structurally
 * the auth package's `PlanActor`; the registry does not import it). For the
 * node operations that are not human-only (`node.inspect`, `node.plan`,
 * Wave 5 correction F9), the caller as the central engine authorized it:
 * its identity kind, client and client id, which the stored plan, the
 * acceptance and the audit keep.
 */
export interface RegistryActor {
  /** A person unless a service account acts (only where the action is not human-only). */
  readonly kind?: 'human' | 'service'
  readonly identityId: IdentityId
  readonly label: string
  /** The session's last re-authentication; a delegated caller has none. */
  readonly reauthAt: string | null
  readonly client?: Exclude<OperationActor['client'], 'system'>
  readonly clientId?: OAuthClientId | null
  /** The OAuth grant of a delegated caller, for the audit (OperationActor.grantId). */
  readonly grantId?: GrantId | null
}

export function operationActor(actor: RegistryActor): OperationActor {
  return {
    kind: actor.kind ?? 'human',
    identityId: actor.identityId,
    label: actor.label,
    client: actor.client ?? 'web',
    clientId: actor.clientId ?? null,
    ...(actor.grantId === undefined || actor.grantId === null ? {} : { grantId: actor.grantId }),
  }
}

export interface RegistryPolicyContext {
  readonly registry: RuleRegistry
  /** `<package version>+<commit>` of the running build (pv1). */
  readonly codeVersion: string
  readonly clock: Clock
}

/**
 * Whom a registry or node policy decision is about: the planning person, or,
 * re-checked from a stored plan, the actor the plan recorded (its kind and
 * client as authenticated; a recorded plan has no re-authentication time).
 */
export interface RegistryPolicyActor {
  readonly kind?: 'human' | 'service'
  readonly identityId: IdentityId | null
  readonly reauthAt: string | null
  readonly client?: Principal['client']
}

/** The policy actor of a stored plan's recorded actor (a re-check at acceptance or dispatch). */
export function recordedPolicyActor(
  actor: Pick<OperationActor, 'kind' | 'identityId' | 'client'>,
): RegistryPolicyActor | 'system' {
  return actor.kind === 'system'
    ? 'system'
    : { kind: actor.kind, identityId: actor.identityId, reauthAt: null, client: actor.client }
}

/** The policy decision for a registry plan (principal facts only; the rules read the subject tier). */
export async function evaluateRegistryPolicy(
  q: Queryable,
  context: RegistryPolicyContext,
  input: {
    readonly kind: string
    /** A person, or `system` for the worker's own suspension of a target (identity mismatch). */
    readonly actor: RegistryPolicyActor | 'system'
    readonly subject: SubjectScope
    readonly content: JsonValue
    /** A break-glass grant the plan is made under (the engine honors it for a person outside MCP only). */
    readonly breakGlass?: BreakGlass
  },
): Promise<PolicyDecision> {
  const engine = new PolicyEngine({
    registry: context.registry,
    providers: [principalFacts],
    codeVersion: context.codeVersion,
    clock: context.clock,
  })
  const actor = input.actor
  const principal: Principal =
    actor === 'system'
      ? { kind: 'system', identityId: null, client: 'system' }
      : {
          kind: actor.kind ?? 'human',
          identityId: actor.identityId,
          client: actor.client ?? 'web',
          ...(actor.reauthAt === null ? {} : { reauthAt: actor.reauthAt }),
        }
  return engine.evaluate({
    request: {
      kind: input.kind,
      principal,
      subject: input.subject,
      content: input.content,
      ...(input.breakGlass === undefined ? {} : { breakGlass: input.breakGlass }),
    },
    settings: await readPolicySettings(q, input.subject),
  })
}

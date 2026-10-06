import type { Queryable } from '@exponetdb/control-store'
import type { Clock, IdentityId, JsonValue, OAuthClientId } from '@exponetdb/kernel'
import { type OperationActor, readPolicySettings } from '@exponetdb/operations'
import {
  type PolicyDecision,
  PolicyEngine,
  principalFacts,
  type RuleRegistry,
  type SubjectScope,
} from '@exponetdb/policy'

/**
 * The person who plans a registry change: a Web App session or the
 * first-party CLI on a person's behalf (registry actions are human-only;
 * a service account never plans one). Structurally the auth package's
 * `PlanActor`; the registry does not import it.
 */
export interface RegistryActor {
  readonly identityId: IdentityId
  readonly label: string
  /** The session's last re-authentication; a delegated caller has none. */
  readonly reauthAt: string | null
  readonly client?: 'web' | 'cli'
  readonly clientId?: OAuthClientId | null
}

export function operationActor(actor: RegistryActor): OperationActor {
  return {
    kind: 'human',
    identityId: actor.identityId,
    label: actor.label,
    client: actor.client ?? 'web',
    clientId: actor.clientId ?? null,
  }
}

export interface RegistryPolicyContext {
  readonly registry: RuleRegistry
  /** `<package version>+<commit>` of the running build (pv1). */
  readonly codeVersion: string
  readonly clock: Clock
}

/** The policy decision for a registry plan (principal facts only; the rules read the subject tier). */
export async function evaluateRegistryPolicy(
  q: Queryable,
  context: RegistryPolicyContext,
  input: {
    readonly kind: string
    readonly actor: Pick<RegistryActor, 'identityId' | 'reauthAt' | 'client'>
    readonly subject: SubjectScope
    readonly content: JsonValue
  },
): Promise<PolicyDecision> {
  const engine = new PolicyEngine({
    registry: context.registry,
    providers: [principalFacts],
    codeVersion: context.codeVersion,
    clock: context.clock,
  })
  return engine.evaluate({
    request: {
      kind: input.kind,
      principal: {
        kind: 'human',
        identityId: input.actor.identityId,
        client: input.actor.client ?? 'web',
        ...(input.actor.reauthAt === null ? {} : { reauthAt: input.actor.reauthAt }),
      },
      subject: input.subject,
      content: input.content,
    },
    settings: await readPolicySettings(q, input.subject),
  })
}

import type { JsonObject } from '../json.ts'
import { signCanonical, verifyCanonical } from './sign.ts'

/**
 * The node result signature `nr1`
 * ([protocol.md §7.5](../../../../exponetdb-docs/07-node-agent/protocol.md#75-node-result-signature-nr1)).
 */

export interface ResultContext {
  readonly installationId: string
  readonly nodeId: string
  readonly jobId: string
  readonly argsHash: string
}

/** The completion request without `nodeSignature`. */
export function unsignedCompletion(complete: JsonObject): JsonObject {
  // Object.fromEntries defines own members, so a member named __proto__ is
  // kept (an assignment would set the prototype and drop it).
  return Object.fromEntries(Object.entries(complete).filter(([name]) => name !== 'nodeSignature'))
}

export function resultSigningValue(context: ResultContext, complete: JsonObject): JsonObject {
  return {
    purpose: 'exponetdb/node-result/nr1',
    installationId: context.installationId,
    nodeId: context.nodeId,
    jobId: context.jobId,
    argsHash: context.argsHash,
    complete: unsignedCompletion(complete),
  }
}

/** Signs a completion with the node signing key (seed); base64url signature. */
export function signResult(seed: Uint8Array, context: ResultContext, complete: JsonObject): string {
  return signCanonical(seed, resultSigningValue(context, complete))
}

/** Verifies `nr1` against the node's bound signing key (raw public key). */
export function verifyResult(
  nodeSigningKey: Uint8Array,
  context: ResultContext,
  complete: JsonObject,
  signature: string,
): boolean {
  return verifyCanonical(nodeSigningKey, resultSigningValue(context, complete), signature)
}

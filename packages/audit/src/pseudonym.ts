import { createHmac } from 'node:crypto'

/**
 * Keyed pseudonyms for request metadata (audit.md §6, OD-8 Wave 2 design).
 * IP addresses and user agents are never stored in clear in audit events;
 * where they are recorded at all, it is as HMAC-SHA-256 under an
 * installation-specific key that lives outside the audit rows (an
 * envelope-encrypted secret, never plaintext in the Control Store). A plain
 * SHA-256 over a small input domain such as IPv4 addresses would be
 * reversible by enumeration; a keyed hash is not without the key.
 *
 *   hmac-sha256:<hex(HMAC-SHA-256(key, "exponetdb/audit-pseudonym/v1" LF kind LF value))>
 *
 * The kind separates domains, so an IP and a user agent with equal text never
 * share a pseudonym. Rotating the key breaks correlation with older events,
 * by design.
 */
export type PseudonymKind =
  | 'ip'
  | 'user_agent'
  /** The canonical (RFC 8785) arguments of an MCP tool call, for the request log of a refusal. */
  | 'tool_arguments'

export interface Pseudonymizer {
  pseudonym(kind: PseudonymKind, value: string): string
}

export function createPseudonymizer(key: Uint8Array): Pseudonymizer {
  if (key.length !== 32) {
    throw new Error('the audit pseudonym key is 32 bytes')
  }
  const copy = Buffer.from(key)
  return {
    pseudonym(kind, value) {
      const mac = createHmac('sha256', copy)
        .update(`exponetdb/audit-pseudonym/v1\n${kind}\n${value}`, 'utf8')
        .digest('hex')
      return `hmac-sha256:${mac}`
    },
  }
}

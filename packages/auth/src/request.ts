import type { RequestId } from '@exponetdb/kernel'

/**
 * Request facts as the HTTP layer resolved them. `clientIp` is the peer
 * address, or the address a configured trusted proxy reported; never a
 * forwarded header from an untrusted peer. Both values are used only as
 * keyed pseudonyms (rate limits, audit) and never stored.
 */
export interface RequestMeta {
  readonly requestId: RequestId
  readonly clientIp: string | undefined
  readonly userAgent: string | undefined
}

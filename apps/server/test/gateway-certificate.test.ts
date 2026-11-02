import type { ServerHttp2Stream } from 'node:http2'
import { describe, expect, it } from 'vitest'
import { certificateExpired, presentedOf } from '../src/interfaces/gateway/agent-listener.ts'

/**
 * VC-150: TLS judges a client certificate's validity once, at the handshake, so a node whose
 * session stayed open past `notAfter` went on heartbeating and was even given another certificate.
 * The listener carries `notAfter` of the verified certificate and refuses the next request.
 */
const stream = (peer: Record<string, unknown>, authorized = true) =>
  ({
    session: { socket: { authorized, getPeerCertificate: () => peer } },
  }) as unknown as ServerHttp2Stream

const peer = (validTo: string) => ({
  subject: { CN: 'nod_01J00000000000000000000000' },
  raw: Buffer.from('der'),
  valid_to: validTo,
})

describe('the verified client certificate of a session (VC-150)', () => {
  it('carries its notAfter', () => {
    const presented = presentedOf(stream(peer('Oct 30 05:57:35 2026 GMT')))
    expect(presented?.nodeId).toBe('nod_01J00000000000000000000000')
    expect(presented?.expiresAtMs).toBe(Date.parse('2026-10-30T05:57:35Z'))
  })

  it('is expired for a request after notAfter and valid before', () => {
    const presented = presentedOf(stream(peer('Oct 30 05:57:35 2026 GMT')))
    expect(certificateExpired(presented, Date.parse('2026-10-30T05:57:34Z'))).toBe(false)
    expect(certificateExpired(presented, Date.parse('2026-10-30T05:57:35Z'))).toBe(true)
    expect(certificateExpired(presented, Date.parse('2026-11-04T00:00:00Z'))).toBe(true)
  })

  it('is never expired for a session without a certificate or without a readable end', () => {
    expect(certificateExpired(undefined, Date.now())).toBe(false)
    expect(certificateExpired(presentedOf(stream(peer('garbage'))), Date.now())).toBe(false)
    expect(presentedOf(stream(peer('Oct 30 05:57:35 2026 GMT'), false))).toBeUndefined()
  })
})

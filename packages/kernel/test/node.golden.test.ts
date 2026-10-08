import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  canonicalize,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parseJson,
  toJsonValue,
} from '../src/index.ts'
import {
  b64u,
  bindProof,
  bindProofMatches,
  decodeToken,
  ed25519PrivateKey,
  encodeToken,
  fromB64u,
  fromB64uOf,
  hpkeOpen,
  hpkeSeal,
  keyFingerprint,
  nodeSigningKeyProofValue,
  openNs1,
  parseNs1,
  rawPublicKey,
  redeemHash,
  redeemKeyMatches,
  renewSignatureValue,
  renewTlsKeyProofValue,
  resultSigningValue,
  sealInfo,
  sealNs1,
  signCanonical,
  signJobEnvelope,
  signResult,
  tlsKeyProofValue,
  tokenKeys,
  verifyCanonical,
  verifyJobEnvelope,
  verifyResult,
  x25519PrivateKey,
} from '../src/node/index.ts'
import { loadGolden } from './golden.ts'

/**
 * The Wave 5 node constructions against their golden vectors
 * (`tooling/golden/node-*.json`, derived independently in Python;
 * protocol.md §7) and HPKE against RFC 9180 A.1.1.
 */

const hex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'))
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex')
function json(value: unknown): JsonObject {
  const checked = toJsonValue(value)
  if (!checked.ok || !isJsonObject(checked.value)) {
    throw new Error('not a JSON object')
  }
  return checked.value
}
function jcs(value: JsonValue): string {
  const c = canonicalize(value)
  if (!c.ok) throw new Error(c.error.code)
  return c.value
}
const raw = (text: string) => fromB64uOf(text, 32) ?? new Uint8Array()

describe('HPKE (RFC 9180 A.1.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base)', () => {
  const pkR = hex('3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d')
  const skR = hex('4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8')
  const skE = hex('52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736')
  const info = hex('4f6465206f6e2061204772656369616e2055726e')
  const aad = hex('436f756e742d30')
  const pt = hex('4265617574792069732074727574682c20747275746820626561757479')

  it('reproduces enc, shared secret, key, base nonce and the first ciphertext', () => {
    const trace: { shared?: string; key?: string; nonce?: string } = {}
    const sealed = hpkeSeal(pkR, info, aad, pt, 'aes-128-gcm', {
      ephemeralSecret: skE,
      trace: (t) => {
        trace.shared = toHex(t.sharedSecret)
        trace.key = toHex(t.key)
        trace.nonce = toHex(t.baseNonce)
      },
    })
    expect(toHex(sealed.enc)).toBe(
      '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431',
    )
    expect(trace).toEqual({
      shared: 'fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc',
      key: '4531685d41d65f03dc48f6b8302c05b0',
      nonce: '56d890e5accaaf011cff4b7d',
    })
    expect(toHex(sealed.ct)).toBe(
      'f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a',
    )
    expect(toHex(hpkeOpen(skR, info, aad, sealed, 'aes-128-gcm') ?? new Uint8Array())).toBe(
      toHex(pt),
    )
    expect(hpkeOpen(skR, info, hex('00'), sealed, 'aes-128-gcm')).toBeUndefined()
  })
})

describe('base64url (protocol.md §7.1)', () => {
  it('refuses padding, other alphabets and non-canonical trailing bits', () => {
    expect(fromB64u('AQ')).toEqual(new Uint8Array([1]))
    expect(fromB64u('AQ==')).toBeUndefined()
    expect(fromB64u('AR')).toBeUndefined()
    expect(fromB64u('A+')).toBeUndefined()
    expect(fromB64u('A')).toBeUndefined()
  })
})

const TrustedKey = z.strictObject({
  keyId: z.string(),
  publicKey: z.string(),
  fingerprint: z.string(),
})
const JobVector = z.strictObject({
  id: z.string(),
  description: z.string(),
  envelope: z.record(z.string(), z.unknown()),
  signingInput: z.string().optional(),
  keyId: z.string(),
  signerSeedHex: z.string().optional(),
  valid: z.boolean(),
  reason: z.string().optional(),
  trustedKeys: z.array(TrustedKey),
})
const jobs = loadGolden('node-job-signature.json', z.object({ vectors: z.array(JobVector) }))

describe('job envelope signature v1 (tooling/golden/node-job-signature.json)', () => {
  for (const v of jobs.vectors) {
    it(`${v.id}: ${v.description}`, () => {
      const trusted = v.trustedKeys.map((k) => {
        expect(keyFingerprint(raw(k.publicKey))).toBe(k.fingerprint)
        return { keyId: k.keyId, publicKey: raw(k.publicKey) }
      })
      const envelope = json(v.envelope)
      const check = verifyJobEnvelope(envelope, trusted)
      if (v.valid) {
        expect(check).toEqual({ ok: true, keyId: v.keyId })
        const { signature: _, ...unsigned } = v.envelope
        expect(jcs(json(unsigned))).toBe(v.signingInput)
        // Ed25519 is deterministic: re-signing reproduces the vector.
        expect(signJobEnvelope(envelope, v.keyId, hex(v.signerSeedHex ?? ''))).toEqual(envelope)
      } else {
        expect(check).toEqual({ ok: false, reason: v.reason })
      }
    })
  }
})

const TokenVector = z.strictObject({
  id: z.string(),
  description: z.string(),
  payload: z.record(z.string(), z.unknown()),
  token: z.string(),
  secretHex: z.string(),
  kRedeemHex: z.string(),
  redeemKey: z.string(),
  redeemHash: z.string(),
  kBindHex: z.string(),
})
const ProofVector = z.strictObject({
  id: z.string(),
  description: z.string(),
  tokenId: z.string(),
  tlsSeedHex: z.string(),
  tlsKey: z.string(),
  tlsKeyProofInput: z.string(),
  tlsKeyProof: z.string(),
  nodeSigningSeedHex: z.string(),
  nodeSigningKey: z.string(),
  nodeSigningKeyProofInput: z.string(),
  nodeSigningKeyProof: z.string(),
  nodeEncryptionSecretHex: z.string(),
  nodeEncryptionKey: z.string(),
  bindInput: z.string(),
  bindProof: z.string(),
})
const RenewVector = z.strictObject({
  id: z.string(),
  description: z.string(),
  nodeId: z.string(),
  tlsSeedHex: z.string(),
  tlsKey: z.string(),
  tlsKeyProofInput: z.string(),
  tlsKeyProof: z.string(),
  nodeSignatureInput: z.string(),
  nodeSignature: z.string(),
})
const InvalidToken = z.strictObject({
  id: z.string(),
  description: z.string(),
  token: z.string(),
  reason: z.string(),
})
const enrollment = loadGolden(
  'node-enrollment.json',
  z.object({ vectors: z.array(z.union([TokenVector, ProofVector, RenewVector, InvalidToken])) }),
)

describe('enrollment token exdbt1 and proofs (tooling/golden/node-enrollment.json)', () => {
  const token = enrollment.vectors.find((v) => v.id === 'tok-001') as z.output<typeof TokenVector>
  const proof = enrollment.vectors.find((v) => v.id === 'proof-001') as z.output<typeof ProofVector>
  const renew = enrollment.vectors.find((v) => v.id === 'proof-002') as z.output<typeof RenewVector>

  it('tok-001: decodes, re-encodes byte for byte, and derives the redeem and bind keys', () => {
    const decoded = decodeToken(token.token)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(toHex(decoded.token.secret)).toBe(token.secretHex)
    expect(encodeToken(decoded.token)).toBe(token.token)
    expect(jcs(json(token.payload))).toBe(
      Buffer.from(token.token.slice('exdbt1.'.length), 'base64url').toString('utf8'),
    )
    const keys = tokenKeys(decoded.token.secret, decoded.token.tokenId)
    expect(toHex(keys.redeem)).toBe(token.kRedeemHex)
    expect(toHex(keys.bind)).toBe(token.kBindHex)
    expect(b64u(keys.redeem)).toBe(token.redeemKey)
    expect(redeemHash(keys.redeem)).toBe(token.redeemHash)
    expect(redeemKeyMatches(token.redeemKey, token.redeemHash)).toBe(true)
    expect(redeemKeyMatches(b64u(keys.bind), token.redeemHash)).toBe(false)
  })

  for (const v of enrollment.vectors.filter((x) => x.id.startsWith('tok-1'))) {
    const bad = v as z.output<typeof InvalidToken>
    it(`${bad.id}: refuses ${bad.description}`, () => {
      expect(decodeToken(bad.token)).toEqual({ ok: false, reason: bad.reason })
    })
  }

  it('proof-001: proofs of possession and the binding proof', () => {
    const tlsSeed = hex(proof.tlsSeedHex)
    const nskSeed = hex(proof.nodeSigningSeedHex)
    expect(b64u(rawPublicKey(ed25519PrivateKey(tlsSeed)))).toBe(proof.tlsKey)
    expect(b64u(rawPublicKey(ed25519PrivateKey(nskSeed)))).toBe(proof.nodeSigningKey)
    expect(b64u(rawPublicKey(x25519PrivateKey(hex(proof.nodeEncryptionSecretHex))))).toBe(
      proof.nodeEncryptionKey,
    )
    const tlsValue = tlsKeyProofValue(proof.tokenId, proof.tlsKey)
    expect(jcs(tlsValue)).toBe(proof.tlsKeyProofInput)
    expect(signCanonical(tlsSeed, tlsValue)).toBe(proof.tlsKeyProof)
    expect(verifyCanonical(raw(proof.tlsKey), tlsValue, proof.tlsKeyProof)).toBe(true)
    const nskValue = nodeSigningKeyProofValue(proof.tokenId, proof.nodeSigningKey)
    expect(jcs(nskValue)).toBe(proof.nodeSigningKeyProofInput)
    expect(signCanonical(nskSeed, nskValue)).toBe(proof.nodeSigningKeyProof)
    const decoded = decodeToken(token.token)
    if (!decoded.ok) throw new Error('token')
    const statement = {
      installationId: decoded.token.installationId,
      serverId: decoded.token.serverId,
      tokenId: decoded.token.tokenId,
      nodeSigningKey: proof.nodeSigningKey,
      nodeEncryptionKey: proof.nodeEncryptionKey,
    }
    const kBind = hex(token.kBindHex)
    expect(bindProof(kBind, statement)).toBe(proof.bindProof)
    expect(bindProofMatches(kBind, statement, proof.bindProof)).toBe(true)
    expect(
      bindProofMatches(kBind, { ...statement, nodeEncryptionKey: proof.tlsKey }, proof.bindProof),
    ).toBe(false)
  })

  it('proof-002: renewal proof of possession and node signature', () => {
    const tlsValue = renewTlsKeyProofValue(renew.nodeId, renew.tlsKey)
    expect(jcs(tlsValue)).toBe(renew.tlsKeyProofInput)
    expect(signCanonical(hex(renew.tlsSeedHex), tlsValue)).toBe(renew.tlsKeyProof)
    const sigValue = renewSignatureValue(renew.nodeId, renew.tlsKey)
    expect(jcs(sigValue)).toBe(renew.nodeSignatureInput)
    expect(signCanonical(hex(proof.nodeSigningSeedHex), sigValue)).toBe(renew.nodeSignature)
    expect(verifyCanonical(raw(proof.nodeSigningKey), sigValue, renew.nodeSignature)).toBe(true)
  })
})

const Context = z.strictObject({
  installationId: z.string(),
  nodeId: z.string(),
  jobId: z.string(),
  argsHash: z.string(),
})
const ResultVector = z.strictObject({
  id: z.string(),
  description: z.string(),
  nodeSigningSeedHex: z.string().optional(),
  nodeSigningKey: z.string(),
  context: Context,
  complete: z.record(z.string(), z.unknown()),
  signingInput: z.string().optional(),
  signature: z.string(),
  valid: z.boolean(),
})
const results = loadGolden('node-result.json', z.object({ vectors: z.array(ResultVector) }))

describe('node result signature nr1 (tooling/golden/node-result.json)', () => {
  for (const v of results.vectors) {
    it(`${v.id}: ${v.description}`, () => {
      const complete = json(v.complete)
      expect(verifyResult(raw(v.nodeSigningKey), v.context, complete, v.signature)).toBe(v.valid)
      if (v.valid) {
        expect(jcs(resultSigningValue(v.context, complete))).toBe(v.signingInput)
        expect(signResult(hex(v.nodeSigningSeedHex ?? ''), v.context, complete)).toBe(v.signature)
        // A nodeSignature member already present is not signed over.
        expect(
          verifyResult(
            raw(v.nodeSigningKey),
            v.context,
            { ...complete, nodeSignature: 'x' },
            v.signature,
          ),
        ).toBe(true)
      }
    })
  }
})

const SealContext = z.strictObject({
  installationId: z.string(),
  nodeId: z.string(),
  jobId: z.string(),
  operationId: z.string(),
  capability: z.strictObject({ name: z.string(), major: z.number() }),
  field: z.string(),
})
const SealedVector = z.strictObject({
  id: z.string(),
  description: z.string(),
  recipientSecretHex: z.string(),
  recipientKey: z.string().optional(),
  ephemeralSecretHex: z.string().optional(),
  context: SealContext,
  info: z.string().optional(),
  plaintextHex: z.string().optional(),
  sharedSecretHex: z.string().optional(),
  keyHex: z.string().optional(),
  baseNonceHex: z.string().optional(),
  sealed: z.strictObject({ enc: z.string(), ct: z.string() }),
  valid: z.boolean().optional(),
})
const sealed = loadGolden('node-sealed.json', z.object({ vectors: z.array(SealedVector) }))

describe('sealed value ns1 (tooling/golden/node-sealed.json)', () => {
  for (const v of sealed.vectors) {
    it(`${v.id}: ${v.description}`, () => {
      const secret = hex(v.recipientSecretHex)
      expect(parseNs1(json({ ns1: v.sealed }))).toEqual(v.sealed)
      if (v.valid === false) {
        expect(openNs1(secret, v.context, v.sealed)).toBeUndefined()
        return
      }
      expect(b64u(rawPublicKey(x25519PrivateKey(secret)))).toBe(v.recipientKey)
      expect(Buffer.from(sealInfo(v.context)).toString('utf8')).toBe(v.info)
      const trace: Record<string, string> = {}
      const out = sealNs1(raw(v.recipientKey ?? ''), v.context, hex(v.plaintextHex ?? ''), {
        ephemeralSecret: hex(v.ephemeralSecretHex ?? ''),
        trace: (t) => {
          trace['shared'] = toHex(t.sharedSecret)
          trace['key'] = toHex(t.key)
          trace['nonce'] = toHex(t.baseNonce)
        },
      })
      expect(out).toEqual({ ns1: v.sealed })
      expect(trace).toEqual({ shared: v.sharedSecretHex, key: v.keyHex, nonce: v.baseNonceHex })
      expect(toHex(openNs1(secret, v.context, v.sealed) ?? new Uint8Array([0xff]))).toBe(
        v.plaintextHex,
      )
      // A random ephemeral key opens the same way.
      const fresh = sealNs1(raw(v.recipientKey ?? ''), v.context, hex(v.plaintextHex ?? ''))
      expect(toHex(openNs1(secret, v.context, fresh.ns1) ?? new Uint8Array([0xff]))).toBe(
        v.plaintextHex,
      )
    })
  }
})

describe('a member named __proto__ is signed like any other (review finding 10)', () => {
  const seed = new Uint8Array(32).fill(3)
  const publicKey = rawPublicKey(ed25519PrivateKey(seed))
  const parse = (text: string): JsonObject => {
    const parsed = parseJson(text)
    if (!parsed.ok || !isJsonObject(parsed.value)) {
      throw new Error('not an object')
    }
    return parsed.value
  }

  it('refuses an envelope or a completion that gained a __proto__ member after signing', () => {
    const signed = signJobEnvelope(
      parse('{"jobId":"job_01JB2Z6G8M4Q7R9T1V3W5X7Y01","a":1}'),
      'k',
      seed,
    )
    const text = canonicalize(signed)
    if (!text.ok) {
      throw new Error('canonicalize')
    }
    const context = { installationId: 'i', nodeId: 'n', jobId: 'j', argsHash: 'h' }
    const signature = signResult(seed, context, parse('{"jobId":"j","outcome":"succeeded"}'))
    for (const injected of ['1', '"x"', 'null', 'true', '[1]', '{}']) {
      const tampered = parse(text.value.replace('{"a":1', `{"__proto__":${injected},"a":1`))
      expect(verifyJobEnvelope(tampered, [{ keyId: 'k', publicKey }]).ok).toBe(false)
      const completion = parse(`{"__proto__":${injected},"jobId":"j","outcome":"succeeded"}`)
      expect(verifyResult(publicKey, context, completion, signature)).toBe(false)
    }
  })

  it('verifies an envelope that carried a __proto__ member when it was signed', () => {
    const envelope = parse('{"__proto__":1,"jobId":"job_01JB2Z6G8M4Q7R9T1V3W5X7Y01"}')
    const signed = signJobEnvelope(envelope, 'k', seed)
    expect(Object.hasOwn(signed, '__proto__')).toBe(true)
    expect(verifyJobEnvelope(signed, [{ keyId: 'k', publicKey }]).ok).toBe(true)
  })
})

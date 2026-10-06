import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  authenticationOptions,
  parseAuthConfig,
  registrationOptions,
  type StoredPasskey,
  SUPPORTED_ALGORITHMS,
  verifyAssertion,
  verifyRegistration,
} from '../src/index.ts'
import { SoftAuthenticator } from '../src/testing/authenticator.ts'

const config = parseAuthConfig({ publicUrl: 'https://db.example.test' })
const ORIGIN = config.publicOrigin
const RP_ID = config.rpId

const handle = (): Uint8Array => new Uint8Array(randomBytes(32))
const challenge = (): string => randomBytes(32).toString('base64url')

function reencodeClientData(encoded: string, patch: Record<string, unknown>): string {
  const data: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  const fields =
    typeof data === 'object' && data !== null ? Object.fromEntries(Object.entries(data)) : {}
  return Buffer.from(JSON.stringify({ ...fields, ...patch })).toString('base64url')
}

async function enrolled(options: { synced?: boolean } = {}) {
  const userHandle = handle()
  const authenticator = new SoftAuthenticator(userHandle, options)
  const registrationChallenge = challenge()
  const registered = await verifyRegistration(
    config,
    authenticator.register({ challenge: registrationChallenge, origin: ORIGIN, rpId: RP_ID }),
    registrationChallenge,
  )
  if (registered === undefined) {
    throw new Error('enrollment failed')
  }
  const stored: StoredPasskey = {
    id: Buffer.from(registered.credentialId).toString('base64url'),
    publicKey: registered.publicKey,
    counter: registered.counter,
    transports: registered.transports,
  }
  return { authenticator, userHandle, stored, registered }
}

describe('passkey options', () => {
  it('requires user verification and a discoverable credential, attestation none, from trusted config', async () => {
    const options = await registrationOptions(config, {
      handle: handle(),
      name: 'owner@example.test',
      displayName: 'Owner',
      exclude: [],
    })
    expect(options.rp).toEqual({ name: 'ExponetDB', id: 'db.example.test' })
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    })
    expect(options.attestation).toBe('none')
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([...SUPPORTED_ALGORITHMS])
    expect(Buffer.from(options.challenge, 'base64url').length).toBeGreaterThanOrEqual(32)
  })

  it('names no account in sign-in options and draws a fresh challenge each time', async () => {
    const a = await authenticationOptions(config)
    const b = await authenticationOptions(config)
    expect(a.allowCredentials).toBeUndefined()
    expect(a.userVerification).toBe('required')
    expect(a.rpId).toBe('db.example.test')
    expect(a.challenge).not.toBe(b.challenge)
    expect(Buffer.from(a.challenge, 'base64url').length).toBeGreaterThanOrEqual(32)
  })
})

describe('passkey registration verification', () => {
  it('accepts a correct ceremony and returns the public key, counter and backup state', async () => {
    const { registered } = await enrolled()
    expect(registered.publicKey.length).toBeGreaterThan(0)
    expect(registered.counter).toBe(0)
    expect(registered.backedUp).toBe(true)
    expect(registered.deviceType).toBe('multiDevice')
  })

  it('refuses a wrong challenge, origin, RP id, ceremony type, cross-origin frame or missing UV/UP', async () => {
    const expected = challenge()
    const base = { challenge: expected, origin: ORIGIN, rpId: RP_ID }
    const cases = [
      { ...base, challenge: challenge() },
      { ...base, origin: 'https://evil.example.test' },
      { ...base, origin: 'http://db.example.test' },
      { ...base, origin: 'https://db.example.test:8443' },
      { ...base, rpId: 'example.test' },
      { ...base, rpId: 'evil.example.test' },
      { ...base, type: 'webauthn.get' },
      { ...base, crossOrigin: true },
      { ...base, userVerified: false },
      { ...base, userPresent: false },
    ]
    for (const input of cases) {
      const authenticator = new SoftAuthenticator(handle())
      expect(
        await verifyRegistration(config, authenticator.register(input), expected),
        JSON.stringify(input),
      ).toBe(undefined)
    }
  })

  it('refuses a ceremony that reports a top-level origin (embedded frame)', async () => {
    const expected = challenge()
    const response = new SoftAuthenticator(handle()).register({
      challenge: expected,
      origin: ORIGIN,
      rpId: RP_ID,
    })
    const framed = {
      ...response,
      response: {
        ...response.response,
        clientDataJSON: reencodeClientData(response.response.clientDataJSON, {
          topOrigin: 'https://evil.example.test',
        }),
      },
    }
    expect(await verifyRegistration(config, framed, expected)).toBeUndefined()
  })

  it('returns undefined instead of throwing for malformed responses', async () => {
    const expected = challenge()
    const response = new SoftAuthenticator(handle()).register({
      challenge: expected,
      origin: ORIGIN,
      rpId: RP_ID,
    })
    const broken = [
      { ...response, response: { ...response.response, clientDataJSON: 'not-json' } },
      { ...response, response: { ...response.response, attestationObject: 'AAAA' } },
      { ...response, response: { ...response.response, attestationObject: '' } },
      { ...response, id: 'other', rawId: 'other' },
    ]
    for (const candidate of broken) {
      await expect(verifyRegistration(config, candidate, expected)).resolves.toBeUndefined()
    }
  })
})

describe('passkey assertion verification', () => {
  it('accepts a correct assertion with the owner handle', async () => {
    const { authenticator, userHandle, stored } = await enrolled()
    const expected = challenge()
    const result = await verifyAssertion(
      config,
      authenticator.assert({ challenge: expected, origin: ORIGIN, rpId: RP_ID }),
      expected,
      stored,
      { userHandle, requireUserHandle: true },
    )
    expect(result).toEqual({ newCounter: 0, backedUp: true })
  })

  it('refuses a wrong challenge, origin, RP id, ceremony type, cross-origin frame or missing UV/UP', async () => {
    const { authenticator, userHandle, stored } = await enrolled()
    const expected = challenge()
    const base = { challenge: expected, origin: ORIGIN, rpId: RP_ID }
    const cases = [
      { ...base, challenge: challenge() },
      { ...base, origin: 'https://evil.example.test' },
      { ...base, rpId: 'example.test' },
      { ...base, type: 'webauthn.create' },
      { ...base, crossOrigin: true },
      { ...base, userVerified: false },
      { ...base, userPresent: false },
    ]
    for (const input of cases) {
      const result = await verifyAssertion(config, authenticator.assert(input), expected, stored, {
        userHandle,
        requireUserHandle: true,
      })
      expect(result, JSON.stringify(input)).toBeUndefined()
    }
  })

  it('refuses the credential of another identity and a user handle that does not match', async () => {
    const alice = await enrolled()
    const bob = await enrolled()
    const expected = challenge()
    const bobsAssertion = bob.authenticator.assert({
      challenge: expected,
      origin: ORIGIN,
      rpId: RP_ID,
    })
    // Bob's credential presented against Alice's stored passkey.
    expect(
      await verifyAssertion(config, bobsAssertion, expected, alice.stored, {
        userHandle: alice.userHandle,
        requireUserHandle: true,
      }),
    ).toBeUndefined()
    // Alice's credential, but the response claims Bob's handle.
    const claimsBob = alice.authenticator.assert({
      challenge: expected,
      origin: ORIGIN,
      rpId: RP_ID,
      userHandle: bob.userHandle,
    })
    expect(
      await verifyAssertion(config, claimsBob, expected, alice.stored, {
        userHandle: alice.userHandle,
        requireUserHandle: true,
      }),
    ).toBeUndefined()
    // Bob's key material under Alice's credential id.
    const swapped = { ...alice.stored, publicKey: bob.stored.publicKey }
    const aliceAssertion = alice.authenticator.assert({
      challenge: expected,
      origin: ORIGIN,
      rpId: RP_ID,
    })
    expect(
      await verifyAssertion(config, aliceAssertion, expected, swapped, {
        userHandle: alice.userHandle,
        requireUserHandle: true,
      }),
    ).toBeUndefined()
  })

  it('requires the user handle for sign-in, and accepts its absence only where the caller already knows the identity', async () => {
    const { authenticator, userHandle, stored } = await enrolled()
    const expected = challenge()
    const noHandle = authenticator.assert({
      challenge: expected,
      origin: ORIGIN,
      rpId: RP_ID,
      userHandle: null,
    })
    expect(
      await verifyAssertion(config, noHandle, expected, stored, {
        userHandle,
        requireUserHandle: true,
      }),
    ).toBeUndefined()
    expect(
      await verifyAssertion(config, noHandle, expected, stored, {
        userHandle,
        requireUserHandle: false,
      }),
    ).toEqual({ newCounter: 0, backedUp: true })
  })

  it('refuses an invalid signature, mismatched ids and malformed responses without throwing', async () => {
    const { authenticator, userHandle, stored } = await enrolled()
    const expected = challenge()
    const good = authenticator.assert({ challenge: expected, origin: ORIGIN, rpId: RP_ID })
    const signature = Buffer.from(good.response.signature, 'base64url')
    signature[signature.length - 1] = (signature[signature.length - 1] ?? 0) ^ 0xff
    const otherId = randomBytes(32).toString('base64url')
    const broken = [
      { ...good, response: { ...good.response, signature: signature.toString('base64url') } },
      { ...good, response: { ...good.response, signature: '' } },
      { ...good, response: { ...good.response, authenticatorData: 'AAAA' } },
      { ...good, response: { ...good.response, clientDataJSON: 'not-json' } },
      {
        ...good,
        response: {
          ...good.response,
          clientDataJSON: reencodeClientData(good.response.clientDataJSON, {
            origin: 'https://evil.example.test',
          }),
        },
      },
      { ...good, id: otherId, rawId: otherId },
      { ...good, rawId: otherId },
    ]
    for (const candidate of broken) {
      await expect(
        verifyAssertion(config, candidate, expected, stored, {
          userHandle,
          requireUserHandle: true,
        }),
      ).resolves.toBeUndefined()
    }
  })

  it('refuses a counter that does not increase for a counting authenticator', async () => {
    const { authenticator, userHandle, stored } = await enrolled({ synced: false })
    const owner = { userHandle, requireUserHandle: true }
    const first = challenge()
    const firstAssertion = authenticator.assert({ challenge: first, origin: ORIGIN, rpId: RP_ID })
    const accepted = await verifyAssertion(config, firstAssertion, first, stored, owner)
    expect(accepted?.newCounter).toBe(1)
    const afterFirst = { ...stored, counter: accepted?.newCounter ?? 0 }
    // The same response again (a replay): the counter did not increase.
    expect(await verifyAssertion(config, firstAssertion, first, afterFirst, owner)).toBeUndefined()
    // A cloned authenticator lagging behind the stored counter.
    const second = challenge()
    const lagging = { ...afterFirst, counter: 5 }
    expect(
      await verifyAssertion(
        config,
        authenticator.assert({ challenge: second, origin: ORIGIN, rpId: RP_ID }),
        second,
        lagging,
        owner,
      ),
    ).toBeUndefined()
  })

  it('accepts a synchronized passkey that always reports counter 0', async () => {
    const { authenticator, userHandle, stored } = await enrolled({ synced: true })
    for (let i = 0; i < 3; i++) {
      const expected = challenge()
      const result = await verifyAssertion(
        config,
        authenticator.assert({ challenge: expected, origin: ORIGIN, rpId: RP_ID }),
        expected,
        stored,
        { userHandle, requireUserHandle: true },
      )
      expect(result).toEqual({ newCounter: 0, backedUp: true })
    }
  })
})

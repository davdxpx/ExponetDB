import type {
  AuthenticationCredential,
  CreationOptions,
  RegistrationCredential,
  RequestOptions,
} from '@exponetdb/contracts'
import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser'

/**
 * The browser half of the passkey ceremonies, through
 * `@simplewebauthn/browser` (bundled into `app.js`, no script from another
 * origin). The options come from the server; the RP ID and origin are the
 * server's trusted configuration, never chosen here.
 */
export class PasskeyCanceled extends Error {
  override readonly name = 'PasskeyCanceled'
}

export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn()
}

const TRANSPORTS = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const
type Transport = (typeof TRANSPORTS)[number]

function transports(list: readonly string[]): Transport[] {
  return list.flatMap((t) => TRANSPORTS.filter((known) => known === t))
}

type Selection = NonNullable<PublicKeyCredentialCreationOptionsJSON['authenticatorSelection']>

/** Copies only the members that are set (the contract allows explicit `undefined`, the library does not). */
function selection(input: NonNullable<CreationOptions['authenticatorSelection']>): Selection {
  return {
    ...(input.residentKey === undefined ? {} : { residentKey: input.residentKey }),
    ...(input.requireResidentKey === undefined
      ? {}
      : { requireResidentKey: input.requireResidentKey }),
    ...(input.userVerification === undefined ? {} : { userVerification: input.userVerification }),
    ...(input.authenticatorAttachment === undefined
      ? {}
      : { authenticatorAttachment: input.authenticatorAttachment }),
  }
}

function canceled(error: unknown): never {
  if (error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    throw new PasskeyCanceled('The passkey prompt was closed or timed out.')
  }
  throw error
}

export async function createPasskey(options: CreationOptions): Promise<RegistrationCredential> {
  const optionsJSON: PublicKeyCredentialCreationOptionsJSON = {
    challenge: options.challenge,
    rp: options.rp,
    user: options.user,
    pubKeyCredParams: options.pubKeyCredParams,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.excludeCredentials === undefined
      ? {}
      : {
          excludeCredentials: options.excludeCredentials.map((c) => ({
            id: c.id,
            type: c.type,
            ...(c.transports === undefined ? {} : { transports: transports(c.transports) }),
          })),
        }),
    ...(options.authenticatorSelection === undefined
      ? {}
      : { authenticatorSelection: selection(options.authenticatorSelection) }),
    ...(options.attestation === undefined ? {} : { attestation: options.attestation }),
  }
  try {
    const response = await startRegistration({ optionsJSON })
    return {
      id: response.id,
      rawId: response.rawId,
      type: 'public-key',
      response: {
        clientDataJSON: response.response.clientDataJSON,
        attestationObject: response.response.attestationObject,
        ...(response.response.authenticatorData === undefined
          ? {}
          : { authenticatorData: response.response.authenticatorData }),
        ...(response.response.transports === undefined
          ? {}
          : { transports: transports(response.response.transports) }),
        ...(response.response.publicKeyAlgorithm === undefined
          ? {}
          : { publicKeyAlgorithm: response.response.publicKeyAlgorithm }),
        ...(response.response.publicKey === undefined
          ? {}
          : { publicKey: response.response.publicKey }),
      },
      ...(response.authenticatorAttachment === undefined
        ? {}
        : { authenticatorAttachment: response.authenticatorAttachment }),
      clientExtensionResults: {},
    }
  } catch (error) {
    return canceled(error)
  }
}

export async function assertWithPasskey(
  options: RequestOptions,
): Promise<AuthenticationCredential> {
  const optionsJSON: PublicKeyCredentialRequestOptionsJSON = {
    challenge: options.challenge,
    ...(options.rpId === undefined ? {} : { rpId: options.rpId }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.userVerification === undefined
      ? {}
      : { userVerification: options.userVerification }),
    ...(options.allowCredentials === undefined
      ? {}
      : {
          allowCredentials: options.allowCredentials.map((c) => ({
            id: c.id,
            type: c.type,
            ...(c.transports === undefined ? {} : { transports: transports(c.transports) }),
          })),
        }),
  }
  try {
    const response = await startAuthentication({ optionsJSON })
    return {
      id: response.id,
      rawId: response.rawId,
      type: 'public-key',
      response: {
        clientDataJSON: response.response.clientDataJSON,
        authenticatorData: response.response.authenticatorData,
        signature: response.response.signature,
        ...(response.response.userHandle === undefined
          ? {}
          : { userHandle: response.response.userHandle }),
      },
      ...(response.authenticatorAttachment === undefined
        ? {}
        : { authenticatorAttachment: response.authenticatorAttachment }),
      clientExtensionResults: {},
    }
  } catch (error) {
    return canceled(error)
  }
}

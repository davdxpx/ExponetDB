import {
  type AuthenticationCredential,
  type CreationOptions,
  CreationOptionsSchema,
  type RegistrationCredential,
  type RequestOptions,
  RequestOptionsSchema,
} from '@exponetdb/contracts'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

/**
 * Conversions between the contract shapes (validated request bodies) and
 * the library's WebAuthn JSON types. Client extension results are dropped:
 * the server ignores them.
 */
export function toAuthenticationResponse(c: AuthenticationCredential): AuthenticationResponseJSON {
  return {
    id: c.id,
    rawId: c.rawId,
    type: 'public-key',
    response: {
      clientDataJSON: c.response.clientDataJSON,
      authenticatorData: c.response.authenticatorData,
      signature: c.response.signature,
      ...(c.response.userHandle === undefined ? {} : { userHandle: c.response.userHandle }),
    },
    clientExtensionResults: {},
    ...(c.authenticatorAttachment === undefined
      ? {}
      : { authenticatorAttachment: c.authenticatorAttachment }),
  }
}

export function toRegistrationResponse(c: RegistrationCredential): RegistrationResponseJSON {
  return {
    id: c.id,
    rawId: c.rawId,
    type: 'public-key',
    response: {
      clientDataJSON: c.response.clientDataJSON,
      attestationObject: c.response.attestationObject,
      ...(c.response.authenticatorData === undefined
        ? {}
        : { authenticatorData: c.response.authenticatorData }),
      ...(c.response.transports === undefined ? {} : { transports: [...c.response.transports] }),
      ...(c.response.publicKeyAlgorithm === undefined
        ? {}
        : { publicKeyAlgorithm: c.response.publicKeyAlgorithm }),
      ...(c.response.publicKey === undefined ? {} : { publicKey: c.response.publicKey }),
    },
    clientExtensionResults: {},
    ...(c.authenticatorAttachment === undefined
      ? {}
      : { authenticatorAttachment: c.authenticatorAttachment }),
  }
}

/** The library's options checked against the contract shape (they are ours; a mismatch is a bug). */
export function requestOptionsView(options: PublicKeyCredentialRequestOptionsJSON): RequestOptions {
  return RequestOptionsSchema.parse(options)
}

export function creationOptionsView(
  options: PublicKeyCredentialCreationOptionsJSON,
): CreationOptions {
  return CreationOptionsSchema.parse(options)
}

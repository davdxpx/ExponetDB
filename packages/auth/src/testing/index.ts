/**
 * Test support of the auth package (never imported by product code): a
 * software WebAuthn authenticator that produces real, independently encoded
 * registration and assertion responses.
 */
export { type CeremonyInput, cbor, SoftAuthenticator } from './authenticator.ts'

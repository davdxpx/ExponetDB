package nodecrypto

import (
	"crypto/ed25519"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// Job signature refusal reasons (protocol.md §4.2, §7.2).
const (
	ReasonSignatureInvalid  = "signature_invalid"
	ReasonUnknownSigningKey = "unknown_signing_key"
)

// SignCanonical signs JCS(value) with the Ed25519 key derived from seed and
// returns the signature as base64url.
func SignCanonical(seed []byte, value canon.Value) (string, error) {
	if len(seed) != ed25519.SeedSize {
		return "", errorf("an Ed25519 seed is %d bytes", ed25519.SeedSize)
	}
	msg, err := canon.Canonicalize(value)
	if err != nil {
		return "", err
	}
	return B64U(ed25519.Sign(ed25519.NewKeyFromSeed(seed), msg)), nil
}

// VerifyCanonical verifies a base64url Ed25519 signature over JCS(value) with
// a raw 32-byte public key. Anything malformed is simply not valid.
func VerifyCanonical(rawPublicKey []byte, value canon.Value, signature string) bool {
	sig, ok := FromB64UOf(signature, ed25519.SignatureSize)
	if !ok || len(rawPublicKey) != ed25519.PublicKeySize {
		return false
	}
	msg, err := canon.Canonicalize(value)
	if err != nil {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(rawPublicKey), msg, sig)
}

// TrustedJobKey is a job-signing key the agent trusts: its id and raw public
// key, anchored by a fingerprint from the enrollment token.
type TrustedJobKey struct {
	KeyID     string
	PublicKey []byte
}

// JobSigningValue is what a job envelope signature covers: every member but
// "signature", in any order (JCS sorts them).
func JobSigningValue(envelope canon.Object) canon.Object {
	out := make(canon.Object, 0, len(envelope))
	for _, m := range envelope {
		if m.Name != "signature" {
			out = append(out, m)
		}
	}
	return out
}

// SignJobEnvelope returns the envelope with its v1 signature. The agent never
// signs jobs; tests and fixtures do.
func SignJobEnvelope(envelope canon.Object, keyID string, seed []byte) (canon.Object, error) {
	unsigned := JobSigningValue(envelope)
	value, err := SignCanonical(seed, unsigned)
	if err != nil {
		return nil, err
	}
	signature := canon.Object{
		{Name: "alg", Value: canon.String("Ed25519")},
		{Name: "keyId", Value: canon.String(keyID)},
		{Name: "value", Value: canon.String(value)},
	}
	return append(unsigned, canon.Member{Name: "signature", Value: signature}), nil
}

// VerifyJobEnvelope verifies the v1 signature of a job envelope against the
// trusted key its keyId names; no other trusted key is ever tried. It returns
// the key id, or the refusal reason when the signature does not verify.
func VerifyJobEnvelope(envelope canon.Object, trusted []TrustedJobKey) (keyID string, reason string) {
	raw, _ := envelope.Get("signature")
	signature, isObject := raw.(canon.Object)
	if !isObject {
		return "", ReasonSignatureInvalid
	}
	alg, _ := signature.Get("alg")
	if name, isString := alg.(canon.String); !isString || name != "Ed25519" {
		return "", ReasonSignatureInvalid
	}
	id, _ := signature.Get("keyId")
	name, isString := id.(canon.String)
	if !isString {
		return "", ReasonUnknownSigningKey
	}
	var key *TrustedJobKey
	for i := range trusted {
		if trusted[i].KeyID == string(name) {
			key = &trusted[i]
			break
		}
	}
	if key == nil {
		return "", ReasonUnknownSigningKey
	}
	value, _ := signature.Get("value")
	text, isString := value.(canon.String)
	if !isString || !VerifyCanonical(key.PublicKey, JobSigningValue(envelope), string(text)) {
		return "", ReasonSignatureInvalid
	}
	return key.KeyID, ""
}

package nodecrypto

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"math/big"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// PgTLSProofValue is what the proof of possession of a PostgreSQL TLS key
// signs (capabilities.md §2, OD-17): the job that generated the key and the
// key itself.
func PgTLSProofValue(jobID, publicKey string) canon.Object {
	return purposeObject("exponetdb/pgtls-pop/v1", "jobId", jobID, "publicKey", publicKey)
}

// P256PublicKey is the uncompressed point (65 bytes) of a P-256 key.
func P256PublicKey(key *ecdsa.PublicKey) ([]byte, error) {
	k, err := key.ECDH()
	if err != nil {
		return nil, err
	}
	return k.Bytes(), nil
}

// SignP256 signs JCS(value) with ECDSA P-256 SHA-256 and returns r || s
// (32 bytes each) as base64url.
func SignP256(key *ecdsa.PrivateKey, value canon.Value) (string, error) {
	msg, err := canon.Canonicalize(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(msg)
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return B64U(sig), nil
}

// VerifyP256 verifies an r || s signature over JCS(value) with an
// uncompressed P-256 public key. Anything malformed is simply not valid.
func VerifyP256(publicKey []byte, value canon.Value, signature string) bool {
	sig, ok := FromB64UOf(signature, 64)
	if !ok {
		return false
	}
	pub, ok := ParseP256PublicKey(publicKey)
	if !ok {
		return false
	}
	msg, err := canon.Canonicalize(value)
	if err != nil {
		return false
	}
	digest := sha256.Sum256(msg)
	return ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
}

// ParseP256PublicKey reads an uncompressed P-256 point (65 bytes), checked
// to be on the curve.
func ParseP256PublicKey(point []byte) (*ecdsa.PublicKey, bool) {
	if len(point) != 65 {
		return nil, false
	}
	if _, err := ecdh.P256().NewPublicKey(point); err != nil {
		return nil, false
	}
	return &ecdsa.PublicKey{
		Curve: elliptic.P256(),
		X:     new(big.Int).SetBytes(point[1:33]),
		Y:     new(big.Int).SetBytes(point[33:]),
	}, true
}

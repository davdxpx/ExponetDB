// Package nodecrypto implements the cryptographic constructions of the node
// protocol (protocol.md §7, ADR-0024): strict base64url, key fingerprints, the
// job envelope signature v1, the enrollment token exdbt1 and the enrollment
// and renewal proofs, the node result signature nr1 and the sealed value ns1
// (HPKE, RFC 9180, base mode).
//
// It is production code of the agent and is written from the specification
// and the golden vectors in tooling/golden, never from the TypeScript code in
// packages/kernel, so that the two implementations check each other. Canonical
// JSON comes from package canon. Standard library only.
package nodecrypto

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
)

// B64U encodes bytes as base64url without padding (RFC 4648 §5).
func B64U(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func isB64UAlphabet(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// FromB64U decodes base64url strictly: no padding, no character outside the
// alphabet (the standard decoder would skip CR and LF), and the canonical
// encoding only, so a value has exactly one spelling. ok is false otherwise.
func FromB64U(s string) (b []byte, ok bool) {
	if !isB64UAlphabet(s) || len(s)%4 == 1 {
		return nil, false
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || B64U(b) != s {
		return nil, false
	}
	return b, true
}

// FromB64UOf is FromB64U that also requires exactly n bytes.
func FromB64UOf(s string, n int) ([]byte, bool) {
	b, ok := FromB64U(s)
	if !ok || len(b) != n {
		return nil, false
	}
	return b, true
}

// KeyFingerprint is "sha256:" + hex(SHA-256(raw public key)).
func KeyFingerprint(rawPublicKey []byte) string {
	sum := sha256.Sum256(rawPublicKey)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// SameFingerprint compares two fingerprints (or any two public strings) in
// constant time.
func SameFingerprint(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// IsID reports whether value is prefix + "_" + a canonical ULID: 26 characters
// of uppercase Crockford base32 (no I, L, O, U) with a first character from 0
// to 7 (domain-model.md §2). Ids are never folded.
func IsID(prefix, value string) bool {
	if len(value) != len(prefix)+27 || value[:len(prefix)] != prefix || value[len(prefix)] != '_' {
		return false
	}
	ulid := value[len(prefix)+1:]
	if ulid[0] < '0' || ulid[0] > '7' {
		return false
	}
	for i := 1; i < len(ulid); i++ {
		c := ulid[i]
		switch {
		case c >= '0' && c <= '9':
		case c >= 'A' && c <= 'Z' && c != 'I' && c != 'L' && c != 'O' && c != 'U':
		default:
			return false
		}
	}
	return true
}

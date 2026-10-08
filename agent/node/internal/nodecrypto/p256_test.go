package nodecrypto

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"testing"
)

func TestPgTLSProofRoundTrip(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	point, err := P256PublicKey(&key.PublicKey)
	if err != nil || len(point) != 65 || point[0] != 4 {
		t.Fatalf("point %d %v", len(point), err)
	}
	value := PgTLSProofValue("job_01JB2Z6G8M4Q7R9T1V3W5X7Y01", B64U(point))
	sig, err := SignP256(key, value)
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyP256(point, value, sig) {
		t.Fatal("proof does not verify")
	}
	other := PgTLSProofValue("job_01JB2Z6G8M4Q7R9T1V3W5X7Y02", B64U(point))
	if VerifyP256(point, other, sig) {
		t.Fatal("proof verifies for another job")
	}
	bad := append([]byte{}, point...)
	bad[64] ^= 1
	if VerifyP256(bad, value, sig) {
		t.Fatal("a point off the curve verifies")
	}
	if _, ok := ParseP256PublicKey(point[:64]); ok {
		t.Fatal("a short point parses")
	}
}

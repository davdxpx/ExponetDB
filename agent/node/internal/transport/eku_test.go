package transport

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/testpki"
)

// A gateway certificate minted by the issuing CA (clientAuth only) is refused
// both when the root is pinned at enrollment and in a session: the two CAs
// are separated by their extended key usage (ADR-0024 §3).
func TestIssuingCACannotMintAGatewayCertificate(t *testing.T) {
	now := time.Now()
	p := testpki.New(now, "gw.example")
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	der, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(999), Subject: pkix.Name{CommonName: "gw.example"}, DNSNames: []string{"gw.example"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}, p.IssuingCA.Cert, pub, p.IssuingCA.Key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	if _, err := verifyPinned([]*x509.Certificate{leaf, p.IssuingCA.Cert, p.Root.Cert}, "gw.example", p.RootFingerprint(), now); err == nil {
		t.Fatal("the enrollment pin accepted a gateway certificate from the issuing CA")
	}
	roots := x509.NewCertPool()
	roots.AddCert(p.Root.Cert)
	intermediates := x509.NewCertPool()
	intermediates.AddCert(p.IssuingCA.Cert)
	if _, err := leaf.Verify(x509.VerifyOptions{DNSName: "gw.example", Roots: roots, Intermediates: intermediates,
		CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err == nil {
		t.Fatal("session verification accepted a gateway certificate from the issuing CA")
	}
}

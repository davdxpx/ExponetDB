package helper

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func newCA(t *testing.T, now time.Time) testCA {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test postgres CA"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return testCA{cert, key}
}

func (ca testCA) issue(t *testing.T, pub *ecdsa.PublicKey, now time.Time) []byte {
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "db.internal"},
		DNSNames: []string{"db.internal"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(12 * time.Hour),
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, pub, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func tlsPlanArgs() canon.Object {
	return canon.Object{
		{Name: "cluster", Value: cluster()},
		{Name: "dnsNames", Value: canon.Array{canon.String("db.internal")}},
		{Name: "ipAddresses", Value: canon.Array{}},
	}
}

func rotateArgs(stagingID, publicKey string, chain [][]byte, expected canon.Value) canon.Object {
	list := canon.Array{}
	for _, c := range chain {
		list = append(list, canon.String(nodecrypto.B64U(c)))
	}
	return canon.Object{
		{Name: "cluster", Value: cluster()},
		{Name: "stagingId", Value: canon.String(stagingID)},
		{Name: "publicKey", Value: canon.String(publicKey)},
		{Name: "certificateChain", Value: list},
		{Name: "expectedCurrentFingerprint", Value: expected},
	}
}

func TestTLSGenerateAndInstall(t *testing.T) {
	e := newEnv(t)
	planJob := e.job("postgres.tls.plan", tlsPlanArgs())
	plan := e.mustCall(OpTLSGenerateKey, planJob)
	if err := e.h.Schema.ValidateResult("postgres.tls.plan@1", plan); err != nil {
		t.Fatal(err)
	}
	id, pubText := str(plan, "stagingId"), str(plan, "publicKey")
	point, _ := nodecrypto.FromB64UOf(pubText, 65)
	v, _ := canon.Parse(planJob)
	jobID := str(v.(canon.Object), "jobId")
	if !nodecrypto.VerifyP256(point, nodecrypto.PgTLSProofValue(jobID, pubText), str(plan, "proof")) {
		t.Fatal("the proof of possession does not verify")
	}
	staged := e.h.StagingDirectory + "/" + id + ".key"
	if info, err := os.Stat(staged); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("staged key %v %v", info, err)
	}
	pub, _ := nodecrypto.ParseP256PublicKey(point)
	ca := newCA(t, e.clk.T)
	leaf := ca.issue(t, pub, e.clk.T)

	// A certificate for another key is refused.
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	e.mustRefuse(OpTLSInstall, e.job("postgres.tls.rotate",
		rotateArgs(id, pubText, [][]byte{ca.issue(t, &other.PublicKey, e.clk.T), ca.cert.Raw}, canon.Null{})), CodePreconditionFailed)
	// A chain whose next certificate did not sign the first is refused.
	e.mustRefuse(OpTLSInstall, e.job("postgres.tls.rotate",
		rotateArgs(id, pubText, [][]byte{leaf, newCA(t, e.clk.T).cert.Raw}, canon.Null{})), CodePreconditionFailed)
	// The plan saw a certificate that is not there.
	e.mustRefuse(OpTLSInstall, e.job("postgres.tls.rotate",
		rotateArgs(id, pubText, [][]byte{leaf, ca.cert.Raw}, canon.String("sha256:"+strings.Repeat("d", 64)))), CodePreconditionFailed)

	r := e.mustCall(OpTLSInstall, e.job("postgres.tls.rotate", rotateArgs(id, pubText, [][]byte{leaf, ca.cert.Raw}, canon.Null{})))
	if str(r, "fingerprint") != fingerprint(leaf) {
		t.Fatalf("result %v", r)
	}
	keyInfo, _ := os.Stat(e.root + e.in.TLSKeyFile)
	certData, _ := os.ReadFile(e.root + e.in.TLSCertificateFile)
	if keyInfo.Mode().Perm() != 0o600 || ownerOf(keyInfo) != e.dataUID {
		t.Fatalf("key file mode %v owner %d", keyInfo.Mode(), ownerOf(keyInfo))
	}
	block, rest := pem.Decode(certData)
	if block == nil || string(block.Bytes) != string(leaf) {
		t.Fatal("the certificate file does not start with the leaf")
	}
	if b2, _ := pem.Decode(rest); b2 == nil || string(b2.Bytes) != string(ca.cert.Raw) {
		t.Fatal("the chain is incomplete")
	}
	if _, err := os.Stat(staged); !os.IsNotExist(err) {
		t.Fatal("the staged key was not removed")
	}
	// A second rotation binds to the installed certificate.
	plan2 := e.mustCall(OpTLSGenerateKey, e.job("postgres.tls.plan", tlsPlanArgs()))
	point2, _ := nodecrypto.FromB64UOf(str(plan2, "publicKey"), 65)
	pub2, _ := nodecrypto.ParseP256PublicKey(point2)
	leaf2 := ca.issue(t, pub2, e.clk.T)
	e.mustRefuse(OpTLSInstall, e.job("postgres.tls.rotate",
		rotateArgs(str(plan2, "stagingId"), str(plan2, "publicKey"), [][]byte{leaf2}, canon.Null{})), CodePreconditionFailed)
	r = e.mustCall(OpTLSInstall, e.job("postgres.tls.rotate",
		rotateArgs(str(plan2, "stagingId"), str(plan2, "publicKey"), [][]byte{leaf2}, canon.String(fingerprint(leaf)))))
	if str(r, "previousFingerprint") != fingerprint(leaf) {
		t.Fatalf("result %v", r)
	}
	if err := e.h.Schema.ValidateResult("postgres.tls.rotate@1", r); err == nil {
		// The helper's part lacks the agent's reload facts; it must not pass
		// as a complete capability result.
		t.Fatal("the helper result passed as the capability result")
	}
}

func TestTLSStagingMustBePrivate(t *testing.T) {
	e := newEnv(t)
	if err := os.Chmod(e.h.StagingDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	e.mustRefuse(OpTLSGenerateKey, e.job("postgres.tls.plan", tlsPlanArgs()), CodeNotConfigured)
	_ = os.Chmod(e.h.StagingDirectory, 0o700)
	e.h.Config.Instances[0].TLSCertificateFile, e.h.Config.Instances[0].TLSKeyFile = "", ""
	e.mustRefuse(OpTLSGenerateKey, e.job("postgres.tls.plan", tlsPlanArgs()), CodeNotConfigured)
}

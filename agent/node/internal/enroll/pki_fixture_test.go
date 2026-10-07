package enroll

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/transport"
)

// The agent PKI fixture is encoded by the Control Plane's TypeScript DER
// encoder (packages/nodes); the agent must accept it with Go's crypto/x509
// and crypto/tls exactly as it accepts the test PKI it builds itself.

type pkiManifest struct {
	Time           string `json:"time"`
	InstallationID string `json:"installationId"`
	NodeID         string `json:"nodeId"`
	ServerName     string `json:"serverName"`
	Comment        string `json:"comment"`
	Certificates   []struct {
		Name    string `json:"name"`
		Profile string `json:"profile"`
		Seed    int    `json:"seed"`
	} `json:"certificates"`
}

func loadPKI(t *testing.T) (pkiManifest, map[string]*x509.Certificate, time.Time) {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for !fileExists(filepath.Join(dir, "tooling", "fixtures", "node-pki")) {
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("tooling/fixtures/node-pki not found")
		}
		dir = parent
	}
	dir = filepath.Join(dir, "tooling", "fixtures", "node-pki")
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m pkiManifest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		t.Fatal(err)
	}
	certs := map[string]*x509.Certificate{}
	for _, c := range m.Certificates {
		der, err := os.ReadFile(filepath.Join(dir, c.Name+".der"))
		if err != nil {
			t.Fatal(err)
		}
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		certs[c.Name] = cert
	}
	at, err := time.Parse(time.RFC3339Nano, m.Time)
	if err != nil {
		t.Fatal(err)
	}
	return m, certs, at
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func fixtureSeed(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

func TestTypeScriptEncodedPKI(t *testing.T) {
	m, certs, at := loadPKI(t)
	now := at.Add(time.Hour)
	tlsKey := nodecrypto.B64U(ed25519.NewKeyFromSeed(fixtureSeed(5)).Public().(ed25519.PublicKey))
	chain := func(leaf, intermediate string) []string {
		return []string{nodecrypto.B64U(certs[leaf].Raw), nodecrypto.B64U(certs[intermediate].Raw)}
	}
	if _, err := CheckCertificate(chain("node", "issuing-ca"), certs["root"], m.InstallationID, m.NodeID, tlsKey, now); err != nil {
		t.Fatalf("node certificate: %v", err)
	}
	if _, err := CheckCertificate(chain("node-from-server-ca", "server-ca"), certs["root"], m.InstallationID, m.NodeID, tlsKey, now); err == nil {
		t.Fatal("accepted a node certificate from the server CA")
	}
	verifyServer := func(leaf, intermediate string) error {
		roots, inter := x509.NewCertPool(), x509.NewCertPool()
		roots.AddCert(certs["root"])
		inter.AddCert(certs[intermediate])
		_, err := certs[leaf].Verify(x509.VerifyOptions{DNSName: m.ServerName, Roots: roots, Intermediates: inter,
			CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
		return err
	}
	if err := verifyServer("gateway", "server-ca"); err != nil {
		t.Fatalf("gateway certificate: %v", err)
	}
	if err := verifyServer("gateway-from-issuing-ca", "issuing-ca"); err == nil {
		t.Fatal("accepted a gateway certificate from the issuing CA")
	}
	if certs["node"].NotAfter.Sub(certs["node"].NotBefore) > 72*time.Hour {
		t.Fatal("node certificate lifetime")
	}

	// A real TLS 1.3 handshake: the enrollment client pins the TypeScript-made
	// root by fingerprint and verifies the TypeScript-made gateway certificate.
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(401)
		_ = json.NewEncoder(w).Encode(protocol.ProtocolError{Code: "NODE_ENROLLMENT_REFUSED", Message: "fixture"})
	}))
	srv.EnableHTTP2 = true
	srv.TLS = &tls.Config{
		MinVersion: tls.VersionTLS13,
		Time:       func() time.Time { return now },
		Certificates: []tls.Certificate{{
			Certificate: [][]byte{certs["gateway"].Raw, certs["server-ca"].Raw, certs["root"].Raw},
			PrivateKey:  ed25519.NewKeyFromSeed(fixtureSeed(4)),
		}},
	}
	srv.StartTLS()
	defer srv.Close()
	sum := sha256.Sum256(certs["root"].Raw)
	v, err := schema.Protocol()
	if err != nil {
		t.Fatal(err)
	}
	client, err := transport.NewEnrollClient(srv.URL, m.ServerName, "sha256:"+hex.EncodeToString(sum[:]), "1.0.0", v, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var resp protocol.EnrollResponse
	err = client.Post(context.Background(), transport.EndpointEnroll, "EnrollRequest", protocol.EnrollRequest{
		TokenID: "ent_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z", RedeemKey: nodecrypto.B64U(make([]byte, 32)), TLSKey: tlsKey,
		TLSKeyProof: nodecrypto.B64U(make([]byte, 64)), NodeSigningKey: tlsKey, NodeSigningKeyProof: nodecrypto.B64U(make([]byte, 64)),
		NodeEncryptionKey: tlsKey, BindProof: nodecrypto.B64U(make([]byte, 32)), AgentVersion: "1.0.0", ProtocolMajors: []int64{1},
		Host: protocol.HostFacts{Hostname: "h", Os: "o", Kernel: "k", Cpus: 1, MemoryBytes: 1, MachineIDHash: "sha256:" + hex.EncodeToString(make([]byte, 32))},
	}, "EnrollResponse", &resp, transport.MaxRequestBytes)
	var pe *transport.ProtocolError
	if !errors.As(err, &pe) || pe.Code != "NODE_ENROLLMENT_REFUSED" {
		t.Fatalf("expected the handshake to succeed and the fixture server to answer: %v", err)
	}
	if client.RootSeen() == nil || !bytes.Equal(client.RootSeen().Raw, certs["root"].Raw) {
		t.Fatal("pinned root")
	}
}

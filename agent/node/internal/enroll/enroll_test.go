package enroll

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
	"github.com/davdxpx/ExponetDB/agent/node/internal/testpki"
	"github.com/davdxpx/ExponetDB/agent/node/internal/transport"
)

const (
	serverName   = "gateway.exdb.internal"
	installation = "ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	server       = "srv_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	tokenID      = "ent_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	nodeID       = "nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
)

var jobSeed = bytes.Repeat([]byte{3}, 32)

// gateway is a fake gateway and worker: it checks every proof the agent
// sends, as the real ones must, and issues certificates from the test PKI.
type gateway struct {
	t        *testing.T
	pki      *testpki.PKI
	secret   []byte
	srv      *httptest.Server
	requests atomic.Int32
	// Misbehavior for negative tests.
	issue  func(pub ed25519.PublicKey) testpki.Cert
	jobKey protocol.EnrollResponseJobKey
	refuse bool
}

func newGateway(t *testing.T, now time.Time, h2 bool, minTLS uint16) *gateway {
	g := &gateway{t: t, pki: testpki.New(now, serverName), secret: bytes.Repeat([]byte{9}, 32)}
	g.issue = func(pub ed25519.PublicKey) testpki.Cert {
		return g.pki.Node(pub, installation, nodeID, testpki.NodeOptions{})
	}
	pub := ed25519.NewKeyFromSeed(jobSeed).Public().(ed25519.PublicKey)
	g.jobKey = protocol.EnrollResponseJobKey{KeyID: "jobkey_2026_10", PublicKey: nodecrypto.B64U(pub)}
	mux := http.NewServeMux()
	mux.HandleFunc(transport.EndpointEnroll, g.enroll)
	mux.HandleFunc(transport.EndpointRenew, g.renew)
	g.srv = httptest.NewUnstartedServer(mux)
	g.srv.EnableHTTP2 = h2
	g.srv.TLS = &tls.Config{
		MinVersion:   minTLS,
		MaxVersion:   minTLS,
		Certificates: []tls.Certificate{g.pki.GatewayTLS()},
		ClientAuth:   tls.VerifyClientCertIfGiven,
		ClientCAs:    g.pki.ClientCAs(),
	}
	if minTLS == tls.VersionTLS13 {
		g.srv.TLS.MaxVersion = 0
	}
	g.srv.StartTLS()
	t.Cleanup(g.srv.Close)
	return g
}

func (g *gateway) url() string { return g.srv.URL }

func (g *gateway) token(t *testing.T, expires time.Time, fingerprint string) string {
	pub := ed25519.NewKeyFromSeed(jobSeed).Public().(ed25519.PublicKey)
	text, err := nodecrypto.EncodeToken(&nodecrypto.EnrollmentToken{
		TokenID: tokenID, InstallationID: installation, ServerID: server,
		Gateway: "https://10.8.2.2:7443", GatewayServerName: serverName, RootFingerprint: fingerprint,
		JobKeys: []nodecrypto.TokenJobKey{{KeyID: "jobkey_2026_10", Fingerprint: nodecrypto.KeyFingerprint(pub)}},
		Secret:  g.secret, ExpiresAt: expires.UTC().Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	return text
}

func (g *gateway) fail(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(protocol.ProtocolError{Code: code, Message: "refused by the test gateway", Retryable: false})
}

func (g *gateway) enroll(w http.ResponseWriter, r *http.Request) {
	g.requests.Add(1)
	if r.ProtoMajor != 2 || r.Header.Get(transport.HeaderProtocol) != protocol.ProtocolID || r.Header.Get(transport.HeaderAgentVersion) == "" {
		g.fail(w, 400, "NODE_PROTOCOL_UNSUPPORTED")
		return
	}
	var req protocol.EnrollRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || g.refuse {
		g.fail(w, 401, "NODE_ENROLLMENT_REFUSED")
		return
	}
	redeem, bind, _ := nodecrypto.TokenKeys(g.secret, req.TokenID)
	tlsKey, _ := nodecrypto.FromB64UOf(req.TLSKey, 32)
	nsk, _ := nodecrypto.FromB64UOf(req.NodeSigningKey, 32)
	switch {
	case !nodecrypto.RedeemKeyMatches(req.RedeemKey, nodecrypto.RedeemHash(redeem)):
		g.fail(w, 401, "NODE_ENROLLMENT_REFUSED")
		return
	case !nodecrypto.VerifyCanonical(tlsKey, nodecrypto.TLSKeyProofValue(req.TokenID, req.TLSKey), req.TLSKeyProof),
		!nodecrypto.VerifyCanonical(nsk, nodecrypto.NodeSigningKeyProofValue(req.TokenID, req.NodeSigningKey), req.NodeSigningKeyProof),
		!nodecrypto.BindProofMatches(bind, nodecrypto.BindStatement{
			InstallationID: installation, ServerID: server, TokenID: req.TokenID,
			NodeSigningKey: req.NodeSigningKey, NodeEncryptionKey: req.NodeEncryptionKey,
		}, req.BindProof):
		g.fail(w, 400, "NODE_PROOF_INVALID")
		return
	}
	cert := g.issue(ed25519.PublicKey(tlsKey))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(protocol.EnrollResponse{
		NodeID: nodeID, InstallationID: installation, ServerID: server,
		CertificateChain:     []string{nodecrypto.B64U(cert.DER), nodecrypto.B64U(g.pki.IssuingCA.DER)},
		CertificateExpiresAt: cert.Cert.NotAfter.UTC().Format(time.RFC3339),
		JobKeys:              []protocol.EnrollResponseJobKey{g.jobKey},
		ServerTime:           g.pki.Now.UTC().Format(time.RFC3339),
	})
}

func (g *gateway) renew(w http.ResponseWriter, r *http.Request) {
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 || r.TLS.PeerCertificates[0].Subject.CommonName != nodeID {
		g.fail(w, 403, "NODE_CERTIFICATE_REFUSED")
		return
	}
	var req protocol.RenewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		g.fail(w, 400, "NODE_PROOF_INVALID")
		return
	}
	g.t.Helper()
	tlsKey, _ := nodecrypto.FromB64UOf(req.TLSKey, 32)
	nsk := renewNSK.Load()
	if !nodecrypto.VerifyCanonical(tlsKey, nodecrypto.RenewTLSKeyProofValue(req.NodeID, req.TLSKey), req.TLSKeyProof) ||
		nsk == nil || !nodecrypto.VerifyCanonical(*nsk, nodecrypto.RenewSignatureValue(req.NodeID, req.TLSKey), req.NodeSignature) {
		g.fail(w, 400, "NODE_PROOF_INVALID")
		return
	}
	cert := g.issue(ed25519.PublicKey(tlsKey))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(protocol.RenewResponse{
		CertificateChain:     []string{nodecrypto.B64U(cert.DER), nodecrypto.B64U(g.pki.IssuingCA.DER)},
		CertificateExpiresAt: cert.Cert.NotAfter.UTC().Format(time.RFC3339),
	})
}

// renewNSK is the node signing key the fake worker bound at enrollment.
var renewNSK atomic.Pointer[ed25519.PublicKey]

func options(t *testing.T, g *gateway, now time.Time) Options {
	v, err := schema.Protocol()
	if err != nil {
		t.Fatal(err)
	}
	return Options{
		AgentVersion: "1.0.0",
		Host: protocol.HostFacts{
			Hostname: "db-host-01", Os: "ubuntu 24.04", Kernel: "6.8.0", Cpus: 8, MemoryBytes: 1 << 34,
			MachineIDHash: "sha256:" + strings.Repeat("3", 64),
		},
		Schema: v, Now: func() time.Time { return now }, Dial: g.url(),
	}
}

func TestEnrollThenRenew(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	g := newGateway(t, now, true, tls.VersionTLS13)
	o := options(t, g, now)
	res, err := Enroll(context.Background(), g.token(t, now.Add(30*time.Minute), g.pki.RootFingerprint()), o)
	if err != nil {
		t.Fatal(err)
	}
	if err := res.State.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := res.Identity.Validate(); err != nil {
		t.Fatal(err)
	}
	if res.State.NodeID != nodeID || res.State.RootFingerprint != g.pki.RootFingerprint() || len(res.State.Trusted()) != 1 {
		t.Fatalf("%+v", res.State)
	}
	if due, err := DueForRenewal(res.Identity, now); err != nil || due {
		t.Fatalf("due right after enrollment: %v %v", due, err)
	}
	if due, _ := DueForRenewal(res.Identity, now.Add(49*time.Hour)); !due {
		t.Fatal("not due at two thirds of the lifetime")
	}

	nsk := ed25519.NewKeyFromSeed(state.Seed(res.Identity.NodeSigningSeed)).Public().(ed25519.PublicKey)
	renewNSK.Store(&nsk)
	cert, err := TLSCertificate(res.Identity)
	if err != nil {
		t.Fatal(err)
	}
	rootDER, _ := nodecrypto.FromB64U(res.State.RootCertificate)
	root, _ := x509.ParseCertificate(rootDER)
	client, err := transport.NewSessionClient(g.url(), serverName, root, cert, "1.0.0", o.Schema)
	if err != nil {
		t.Fatal(err)
	}
	next, err := Renew(context.Background(), client, res.State, res.Identity, now, nil)
	if err != nil {
		t.Fatal(err)
	}
	if next.TLSSeed == res.Identity.TLSSeed || next.NodeSigningSeed != res.Identity.NodeSigningSeed {
		t.Fatal("renewal must replace the TLS key and keep the node signing key")
	}
	cert, _ = TLSCertificate(next)
	client.SetCertificate(cert)
	if _, err := Renew(context.Background(), client, res.State, next, now, nil); err != nil {
		t.Fatalf("second renewal with the new certificate: %v", err)
	}
}

func TestEnrollRefuses(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	for _, c := range []struct {
		name     string
		h2       bool
		tlsMin   uint16
		setup    func(*gateway)
		token    func(*gateway) string
		reached  bool
		contains string
	}{
		{name: "root not in the gateway's chain", h2: true, tlsMin: tls.VersionTLS13,
			token:    func(g *gateway) string { return g.token(t, now.Add(time.Minute), "sha256:"+strings.Repeat("ab", 32)) },
			contains: "pinned root"},
		{name: "job key not in the token", h2: true, tlsMin: tls.VersionTLS13, reached: true,
			setup: func(g *gateway) {
				other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{4}, 32)).Public().(ed25519.PublicKey)
				g.jobKey.PublicKey = nodecrypto.B64U(other)
			}, contains: "does not match the token"},
		{name: "certificate for another key", h2: true, tlsMin: tls.VersionTLS13, reached: true,
			setup: func(g *gateway) {
				other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{5}, 32)).Public().(ed25519.PublicKey)
				g.issue = func(ed25519.PublicKey) testpki.Cert {
					return g.pki.Node(other, installation, nodeID, testpki.NodeOptions{})
				}
			}, contains: "TLS key"},
		{name: "certificate for another node", h2: true, tlsMin: tls.VersionTLS13, reached: true,
			setup: func(g *gateway) {
				g.issue = func(pub ed25519.PublicKey) testpki.Cert {
					return g.pki.Node(pub, installation, nodeID, testpki.NodeOptions{CN: "nod_01JB2Z6G8M4Q7R9T1V3W5X7YA0"})
				}
			}, contains: "another node"},
		{name: "certificate from the server CA (EKU separation)", h2: true, tlsMin: tls.VersionTLS13, reached: true,
			setup: func(g *gateway) {
				g.issue = func(pub ed25519.PublicKey) testpki.Cert {
					return g.pki.Node(pub, installation, nodeID, testpki.NodeOptions{Issuer: &g.pki.ServerCA})
				}
			}, contains: "certificate"},
		{name: "server certificate as client certificate", h2: true, tlsMin: tls.VersionTLS13, reached: true,
			setup: func(g *gateway) {
				g.issue = func(pub ed25519.PublicKey) testpki.Cert {
					return g.pki.Node(pub, installation, nodeID, testpki.NodeOptions{EKU: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
				}
			}, contains: "certificate"},
		{name: "refused by the gateway", h2: true, tlsMin: tls.VersionTLS13, reached: true,
			setup: func(g *gateway) { g.refuse = true }, contains: "NODE_ENROLLMENT_REFUSED"},
		{name: "expired token", h2: true, tlsMin: tls.VersionTLS13,
			token:    func(g *gateway) string { return g.token(t, now.Add(-time.Second), g.pki.RootFingerprint()) },
			contains: "expired"},
		{name: "gateway without HTTP/2", h2: false, tlsMin: tls.VersionTLS13, contains: "HTTP/2"},
		{name: "gateway limited to TLS 1.2", h2: true, tlsMin: tls.VersionTLS12, contains: "protocol version"},
	} {
		t.Run(c.name, func(t *testing.T) {
			g := newGateway(t, now, c.h2, c.tlsMin)
			if c.setup != nil {
				c.setup(g)
			}
			token := g.token(t, now.Add(30*time.Minute), g.pki.RootFingerprint())
			if c.token != nil {
				token = c.token(g)
			}
			res, err := Enroll(context.Background(), token, options(t, g, now))
			if err == nil || res != nil {
				t.Fatalf("enrolled: %+v", res)
			}
			if !strings.Contains(err.Error(), c.contains) {
				t.Fatalf("error %q does not mention %q", err, c.contains)
			}
			if reached := g.requests.Load() > 0; reached != c.reached {
				t.Fatalf("gateway reached: %v", reached)
			}
			var pe *transport.ProtocolError
			if c.name == "refused by the gateway" && (!errors.As(err, &pe) || pe.Status != 401) {
				t.Fatalf("protocol error: %v", err)
			}
		})
	}
}

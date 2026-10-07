package transport

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/testpki"
)

const nodeID = "nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"

func session(t *testing.T, handler http.HandlerFunc, serverPKI, clientPKI *testpki.PKI, serverName string) *Client {
	t.Helper()
	srv := httptest.NewUnstartedServer(handler)
	srv.EnableHTTP2 = true
	srv.TLS = &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{serverPKI.GatewayTLS()},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    serverPKI.ClientCAs(),
	}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, 32))
	cert := serverPKI.Node(key.Public().(ed25519.PublicKey), "ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z", nodeID, testpki.NodeOptions{})
	v, err := schema.Protocol()
	if err != nil {
		t.Fatal(err)
	}
	c, err := NewSessionClient(srv.URL, serverName, clientPKI.Root.Cert, tls.Certificate{
		Certificate: [][]byte{cert.DER, serverPKI.IssuingCA.DER}, PrivateKey: key,
	}, "1.0.0", v)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return c
}

func heartbeatOK(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"serverTime":"2026-10-07T12:00:00Z","instructions":{"renewCertificate":false}}`))
}

func claim(t *testing.T, c *Client) error {
	t.Helper()
	var resp protocol.HeartbeatResponse
	return c.Post(context.Background(), EndpointClaim, "ClaimRequest",
		protocol.ClaimRequest{NodeID: nodeID, WaitSeconds: 0}, "HeartbeatResponse", &resp, MaxRequestBytes)
}

func TestSessionClient(t *testing.T) {
	now := time.Now()
	pki := testpki.New(now, "gateway.exdb.internal")
	if err := claim(t, session(t, heartbeatOK, pki, pki, "gateway.exdb.internal")); err != nil {
		t.Fatalf("valid session: %v", err)
	}
	other := testpki.New(now, "gateway.exdb.internal")
	if err := claim(t, session(t, heartbeatOK, pki, other, "gateway.exdb.internal")); err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("gateway under another root: %v", err)
	}
	if err := claim(t, session(t, heartbeatOK, pki, pki, "other.exdb.internal")); err == nil {
		t.Fatal("accepted a gateway certificate for another name")
	}
	huge := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"pad":"` + strings.Repeat("x", maxResponseBytes) + `"}`))
	}
	if err := claim(t, session(t, huge, pki, pki, "gateway.exdb.internal")); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("oversized response: %v", err)
	}
	extra := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"serverTime":"2026-10-07T12:00:00Z","instructions":{"renewCertificate":false},"exec":"id"}`))
	}
	if err := claim(t, session(t, extra, pki, pki, "gateway.exdb.internal")); err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Fatalf("response outside its schema: %v", err)
	}
}

func TestInvalidRequestIsNotSent(t *testing.T) {
	now := time.Now()
	pki := testpki.New(now, "gateway.exdb.internal")
	called := false
	c := session(t, func(w http.ResponseWriter, r *http.Request) { called = true; heartbeatOK(w, r) }, pki, pki, "gateway.exdb.internal")
	var resp protocol.HeartbeatResponse
	err := c.Post(context.Background(), EndpointClaim, "ClaimRequest",
		protocol.ClaimRequest{NodeID: nodeID, WaitSeconds: 99}, "HeartbeatResponse", &resp, MaxRequestBytes)
	if err == nil || called {
		t.Fatalf("sent an invalid request: %v", err)
	}
}

// Package testgateway is a fake gateway and worker for the agent's tests:
// HTTP/2 with TLS 1.3 from the test PKI, the agent API of protocol.md, every
// proof checked as the real Control Plane must, and switches for
// misbehavior. Imported by tests only.
package testgateway

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/testpki"
)

// Fixed identities of the fake installation.
const (
	ServerName   = "gateway.exdb.internal"
	Installation = "ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	Server       = "srv_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	TokenID      = "ent_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	NodeID       = "nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	OperationID  = "op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
)

// JobKey is a job-signing key of the fake worker.
type JobKey struct {
	ID   string
	Seed []byte
}

// Public returns the key's raw public key.
func (k JobKey) Public() ed25519.PublicKey {
	return ed25519.NewKeyFromSeed(k.Seed).Public().(ed25519.PublicKey)
}

// Completion is a received completion with its verdict.
type Completion struct {
	Request  protocol.JobCompleteRequest
	Raw      canon.Object
	NR1Valid bool
}

// Gateway is the fake.
type Gateway struct {
	t      *testing.T
	PKI    *testpki.PKI
	srv    *httptest.Server
	secret []byte
	Key    JobKey

	mu           sync.Mutex
	nsk          ed25519.PublicKey
	queue        []canon.Object
	argsHash     map[string]string
	completions  map[string]Completion
	hellos       []protocol.HelloRequest
	heartbeats   int
	starts       []string
	cancel       map[string]bool
	refuseStart  map[string]bool
	failComplete int
	progress     map[string]int
	arrived      chan string
	received     map[string]int
	bodies       map[string][][]byte
	seenKeys     []string
	// SlowHeartbeat delays each heartbeat answer (an HTTP/2 stream kept open).
	SlowHeartbeat time.Duration
}

// New starts a fake gateway.
func New(t *testing.T, now time.Time) *Gateway {
	g := &Gateway{
		t: t, PKI: testpki.New(now, ServerName), secret: bytes.Repeat([]byte{9}, 32),
		Key:         JobKey{ID: "jobkey_2026_10", Seed: bytes.Repeat([]byte{3}, 32)},
		argsHash:    map[string]string{},
		completions: map[string]Completion{}, cancel: map[string]bool{}, refuseStart: map[string]bool{},
		progress: map[string]int{}, arrived: make(chan string, 64), received: map[string]int{},
		bodies: map[string][][]byte{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/agent/v1/enroll", g.enroll)
	mux.HandleFunc("/agent/v1/hello", g.hello)
	mux.HandleFunc("/agent/v1/heartbeat", g.heartbeat)
	mux.HandleFunc("/agent/v1/jobs/claim", g.claim)
	mux.HandleFunc("/agent/v1/renew", g.renew)
	mux.HandleFunc("/agent/v1/jobs/", g.job)
	g.srv = httptest.NewUnstartedServer(mux)
	g.srv.EnableHTTP2 = true
	g.srv.TLS = &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{g.PKI.GatewayTLS()},
		ClientAuth:   tls.VerifyClientCertIfGiven,
		ClientCAs:    g.PKI.ClientCAs(),
	}
	g.srv.StartTLS()
	t.Cleanup(g.srv.Close)
	return g
}

// URL is the gateway's address.
func (g *Gateway) URL() string { return g.srv.URL }

// Token returns an enrollment token for this gateway.
func (g *Gateway) Token(expires time.Time) string {
	text, err := nodecrypto.EncodeToken(&nodecrypto.EnrollmentToken{
		TokenID: TokenID, InstallationID: Installation, ServerID: Server,
		Gateway: "https://10.8.2.2:7443", GatewayServerName: ServerName, RootFingerprint: g.PKI.RootFingerprint(),
		JobKeys: []nodecrypto.TokenJobKey{{KeyID: g.Key.ID, Fingerprint: nodecrypto.KeyFingerprint(g.Key.Public())}},
		Secret:  g.secret, ExpiresAt: expires.UTC().Format(time.RFC3339),
	})
	if err != nil {
		g.t.Fatal(err)
	}
	return text
}

func (g *Gateway) answer(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (g *Gateway) fail(w http.ResponseWriter, status int, code string, retryable bool) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(protocol.ProtocolError{Code: code, Message: "test gateway", Retryable: retryable})
}

func (g *Gateway) node(w http.ResponseWriter, r *http.Request) bool {
	if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
		if k, ok := r.TLS.PeerCertificates[0].PublicKey.(ed25519.PublicKey); ok {
			g.mu.Lock()
			g.seenKeys = append(g.seenKeys, nodecrypto.B64U(k))
			g.mu.Unlock()
		}
	}
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 || r.TLS.PeerCertificates[0].Subject.CommonName != NodeID {
		g.fail(w, 403, "NODE_CERTIFICATE_REFUSED", false)
		return false
	}
	if r.Header.Get("X-Exponetdb-Protocol") != protocol.ProtocolID || r.Header.Get("X-Exponetdb-Agent-Version") == "" {
		g.fail(w, 400, "NODE_PROTOCOL_UNSUPPORTED", false)
		return false
	}
	return true
}

func (g *Gateway) enroll(w http.ResponseWriter, r *http.Request) {
	var req protocol.EnrollRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		g.fail(w, 400, "NODE_PROOF_INVALID", false)
		return
	}
	redeem, bind, _ := nodecrypto.TokenKeys(g.secret, req.TokenID)
	tlsKey, _ := nodecrypto.FromB64UOf(req.TLSKey, 32)
	nsk, _ := nodecrypto.FromB64UOf(req.NodeSigningKey, 32)
	if !nodecrypto.RedeemKeyMatches(req.RedeemKey, nodecrypto.RedeemHash(redeem)) {
		g.fail(w, 401, "NODE_ENROLLMENT_REFUSED", false)
		return
	}
	if !nodecrypto.VerifyCanonical(tlsKey, nodecrypto.TLSKeyProofValue(req.TokenID, req.TLSKey), req.TLSKeyProof) ||
		!nodecrypto.VerifyCanonical(nsk, nodecrypto.NodeSigningKeyProofValue(req.TokenID, req.NodeSigningKey), req.NodeSigningKeyProof) ||
		!nodecrypto.BindProofMatches(bind, nodecrypto.BindStatement{InstallationID: Installation, ServerID: Server, TokenID: req.TokenID,
			NodeSigningKey: req.NodeSigningKey, NodeEncryptionKey: req.NodeEncryptionKey}, req.BindProof) {
		g.fail(w, 400, "NODE_PROOF_INVALID", false)
		return
	}
	g.mu.Lock()
	g.nsk = nsk
	g.mu.Unlock()
	cert := g.PKI.Node(ed25519.PublicKey(tlsKey), Installation, NodeID, testpki.NodeOptions{})
	g.answer(w, protocol.EnrollResponse{
		NodeID: NodeID, InstallationID: Installation, ServerID: Server,
		CertificateChain:     []string{nodecrypto.B64U(cert.DER), nodecrypto.B64U(g.PKI.IssuingCA.DER)},
		CertificateExpiresAt: cert.Cert.NotAfter.UTC().Format(time.RFC3339),
		JobKeys:              []protocol.EnrollResponseJobKey{{KeyID: g.Key.ID, PublicKey: nodecrypto.B64U(g.Key.Public())}},
		ServerTime:           time.Now().UTC().Format(time.RFC3339),
	})
}

func (g *Gateway) hello(w http.ResponseWriter, r *http.Request) {
	if !g.node(w, r) {
		return
	}
	var req protocol.HelloRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	g.mu.Lock()
	g.hellos = append(g.hellos, req)
	g.mu.Unlock()
	g.answer(w, protocol.HelloResponse{ProtocolMajor: 1, ServerTime: time.Now().UTC().Format(time.RFC3339Nano),
		AcceptedCapabilities: req.Capabilities})
}

func (g *Gateway) heartbeat(w http.ResponseWriter, r *http.Request) {
	if !g.node(w, r) {
		return
	}
	g.mu.Lock()
	g.heartbeats++
	slow := g.SlowHeartbeat
	g.mu.Unlock()
	time.Sleep(slow)
	g.answer(w, protocol.HeartbeatResponse{ServerTime: time.Now().UTC().Format(time.RFC3339Nano)})
}

func (g *Gateway) claim(w http.ResponseWriter, r *http.Request) {
	if !g.node(w, r) {
		return
	}
	deadline := time.Now().Add(50 * time.Millisecond)
	for {
		g.mu.Lock()
		if r.Context().Err() != nil {
			// The agent gave up this claim (it stopped): never hand it a job,
			// which would be lost with the answer.
			g.mu.Unlock()
			return
		}
		if len(g.queue) > 0 {
			job := g.queue[0]
			g.queue = g.queue[1:]
			g.mu.Unlock()
			out, _ := canon.Canonicalize(canon.Object{{Name: "job", Value: job}})
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(out)
			return
		}
		g.mu.Unlock()
		if time.Now().After(deadline) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"job":null}`))
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (g *Gateway) renew(w http.ResponseWriter, r *http.Request) {
	if !g.node(w, r) {
		return
	}
	var req protocol.RenewRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	tlsKey, _ := nodecrypto.FromB64UOf(req.TLSKey, 32)
	g.mu.Lock()
	nsk := g.nsk
	g.mu.Unlock()
	if !nodecrypto.VerifyCanonical(tlsKey, nodecrypto.RenewTLSKeyProofValue(req.NodeID, req.TLSKey), req.TLSKeyProof) ||
		!nodecrypto.VerifyCanonical(nsk, nodecrypto.RenewSignatureValue(req.NodeID, req.TLSKey), req.NodeSignature) {
		g.fail(w, 400, "NODE_PROOF_INVALID", false)
		return
	}
	cert := g.PKI.Node(ed25519.PublicKey(tlsKey), Installation, NodeID, testpki.NodeOptions{})
	g.answer(w, protocol.RenewResponse{
		CertificateChain:     []string{nodecrypto.B64U(cert.DER), nodecrypto.B64U(g.PKI.IssuingCA.DER)},
		CertificateExpiresAt: cert.Cert.NotAfter.UTC().Format(time.RFC3339),
	})
}

func (g *Gateway) job(w http.ResponseWriter, r *http.Request) {
	if !g.node(w, r) {
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/agent/v1/jobs/")
	jobID, action, _ := strings.Cut(rest, "/")
	g.mu.Lock()
	defer g.mu.Unlock()
	switch action {
	case "start":
		if g.refuseStart[jobID] {
			g.fail(w, 409, "JOB_EXPIRED", false)
			return
		}
		g.starts = append(g.starts, jobID)
		g.answer(w, protocol.JobStartResponse{LeaseExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339)})
	case "progress":
		g.progress[jobID]++
		g.answer(w, protocol.JobProgressResponse{LeaseExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339), CancelRequested: g.cancel[jobID]})
	case "complete":
		g.received[jobID]++
		data, _ := io.ReadAll(r.Body)
		g.bodies[jobID] = append(g.bodies[jobID], data)
		if g.failComplete > 0 {
			g.failComplete--
			g.fail(w, 503, "NODE_OFFLINE", true)
			return
		}
		v, err := canon.Parse(data)
		o, _ := v.(canon.Object)
		var req protocol.JobCompleteRequest
		if err != nil || json.Unmarshal(data, &req) != nil {
			g.fail(w, 400, "NODE_PROOF_INVALID", false)
			return
		}
		_, dup := g.completions[jobID]
		valid := nodecrypto.VerifyResult(g.nsk, nodecrypto.ResultContext{
			InstallationID: Installation, NodeID: req.NodeID, JobID: jobID, ArgsHash: g.argsHash[jobID],
		}, o, req.NodeSignature.Value)
		if !dup {
			g.completions[jobID] = Completion{Request: req, Raw: o, NR1Valid: valid}
		}
		g.answer(w, protocol.JobCompleteResponse{Accepted: !dup, Duplicate: dup})
		select {
		case g.arrived <- jobID:
		default:
		}
	default:
		g.fail(w, 404, "NOT_FOUND", false)
	}
}

// Enqueue hands out an envelope at the next claim; argsHash is what the
// worker's job record holds (the completion's nr1 binds it).
func (g *Gateway) Enqueue(envelope canon.Object) {
	g.mu.Lock()
	defer g.mu.Unlock()
	id, _ := envelope.Get("jobId")
	hash, _ := envelope.Get("argsHash")
	s, _ := id.(canon.String)
	h, _ := hash.(canon.String)
	g.argsHash[string(s)] = string(h)
	g.queue = append(g.queue, envelope)
}

// Job builds a signed envelope for name@1 with args, valid from now.
func (g *Gateway) Job(t *testing.T, key JobKey, jobID, nonce, name string, args canon.Object, now time.Time) canon.Object {
	t.Helper()
	b, err := canon.Canonicalize(args)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	e := canon.Object{
		{Name: "jobId", Value: canon.String(jobID)},
		{Name: "operationId", Value: canon.String(OperationID)},
		{Name: "nodeId", Value: canon.String(NodeID)},
		{Name: "capability", Value: canon.Object{{Name: "name", Value: canon.String(name)}, {Name: "major", Value: canon.Number(1)}}},
		{Name: "args", Value: args},
		{Name: "argsHash", Value: canon.String("sha256:" + hex.EncodeToString(sum[:]))},
		{Name: "notBefore", Value: canon.String(now.UTC().Format(time.RFC3339))},
		{Name: "expiresAt", Value: canon.String(now.Add(15 * time.Minute).UTC().Format(time.RFC3339))},
		{Name: "nonce", Value: canon.String(nonce)},
		{Name: "issuedAt", Value: canon.String(now.UTC().Format(time.RFC3339))},
		{Name: "attempt", Value: canon.Number(1)},
	}
	signed, err := nodecrypto.SignJobEnvelope(e, key.ID, key.Seed)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

// WaitCompletion waits for the completion of jobID.
func (g *Gateway) WaitCompletion(t *testing.T, jobID string, timeout time.Duration) Completion {
	t.Helper()
	deadline := time.After(timeout)
	for {
		g.mu.Lock()
		c, ok := g.completions[jobID]
		g.mu.Unlock()
		if ok {
			return c
		}
		select {
		case <-g.arrived:
		case <-deadline:
			t.Fatalf("no completion for %s", jobID)
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// Hellos returns the hello requests received.
func (g *Gateway) Hellos() []protocol.HelloRequest {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]protocol.HelloRequest{}, g.hellos...)
}

// Heartbeats returns how many heartbeats arrived.
func (g *Gateway) Heartbeats() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.heartbeats
}

// Starts returns the jobs whose start was acknowledged.
func (g *Gateway) Starts() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string{}, g.starts...)
}

// Cancel asks for jobID to be canceled at its next progress.
func (g *Gateway) Cancel(jobID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.cancel[jobID] = true
}

// Bodies returns the body of every completion request for jobID, in order,
// duplicates and failed deliveries included.
func (g *Gateway) Bodies(jobID string) [][]byte {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([][]byte{}, g.bodies[jobID]...)
}

// Received is how many completion requests for jobID arrived, duplicates and
// failed deliveries included.
func (g *Gateway) Received(jobID string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.received[jobID]
}

// SeenKeys lists the client certificate key presented with each request.
func (g *Gateway) SeenKeys() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string{}, g.seenKeys...)
}

// RefuseStart makes the start of jobID fail for good.
func (g *Gateway) RefuseStart(jobID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.refuseStart[jobID] = true
}

// FailCompletions makes the next n completions fail with a retryable error.
func (g *Gateway) FailCompletions(n int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.failComplete = n
}

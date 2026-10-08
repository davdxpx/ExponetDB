// Package transport is the agent's HTTP/2 client to the gateway
// (protocol.md §1, enrollment.md §2): TLS 1.3 only, HTTP/2 only, the gateway
// verified against the pinned ExponetDB root (never the Web PKI), JSON bodies
// within the protocol's size limits, responses decoded strictly and checked
// against their message schema.
package transport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
)

// Protocol headers (protocol.md §1).
const (
	HeaderProtocol     = "X-Exponetdb-Protocol"
	HeaderAgentVersion = "X-Exponetdb-Agent-Version"
)

// Size limits (protocol.md §5).
const (
	MaxRequestBytes   = 1024 * 1024
	MaxHeartbeatBytes = 64 * 1024
	maxResponseBytes  = 1024 * 1024
)

// Endpoints (contracts NODE_PROTOCOL_ENDPOINTS).
const (
	EndpointEnroll    = "/agent/v1/enroll"
	EndpointHello     = "/agent/v1/hello"
	EndpointHeartbeat = "/agent/v1/heartbeat"
	EndpointClaim     = "/agent/v1/jobs/claim"
	EndpointRenew     = "/agent/v1/renew"
)

// JobEndpoint returns /agent/v1/jobs/{jobId}/{action} for start, progress or complete.
func JobEndpoint(jobID, action string) string {
	return "/agent/v1/jobs/" + jobID + "/" + action
}

// ProtocolError is a gateway answer with an error code from the catalog.
type ProtocolError struct {
	Status    int
	Code      string
	Message   string
	Retryable bool
}

func (e *ProtocolError) Error() string {
	return fmt.Sprintf("gateway %d %s: %s", e.Status, e.Code, e.Message)
}

// ErrRequestInvalid: the agent refused to send a request that breaks its own
// message schema or size limit; sending it again cannot succeed.
var ErrRequestInvalid = errors.New("transport: request refused locally")

// requestTimeout bounds one request, the claim long poll included.
const requestTimeout = 60 * time.Second

// Client talks to one gateway.
type Client struct {
	base         string
	agentVersion string
	tlsConfig    *tls.Config
	mu           sync.Mutex
	http         *http.Client
	transport    *http.Transport
	schema       *schema.Validator
	cert         atomic.Pointer[tls.Certificate]
	rootSeen     atomic.Pointer[x509.Certificate]
}

func baseTLS(serverName string) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS13,
		MaxVersion: tls.VersionTLS13,
		ServerName: serverName,
		NextProtos: []string{"h2"},
	}
}

// requireH2 refuses a connection on which the gateway did not agree to
// HTTP/2, inside the handshake, before any request is sent.
func requireH2(cs tls.ConnectionState) error {
	if cs.NegotiatedProtocol != "h2" {
		return errors.New("transport: the gateway does not speak HTTP/2")
	}
	return nil
}

func newTransport(cfg *tls.Config) (*http.Transport, *http.Client) {
	t := &http.Transport{
		TLSClientConfig:        cfg,
		ForceAttemptHTTP2:      true,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  40 * time.Second,
		IdleConnTimeout:        90 * time.Second,
		MaxResponseHeaderBytes: 64 * 1024,
		Proxy:                  nil,
	}
	return t, &http.Client{Transport: t, Timeout: requestTimeout, CheckRedirect: noRedirects}
}

func newClient(gatewayURL, agentVersion string, cfg *tls.Config, v *schema.Validator) (*Client, error) {
	if !nodecrypto.IsGateway(gatewayURL) {
		return nil, fmt.Errorf("transport: %q is not a gateway address", gatewayURL)
	}
	t, h := newTransport(cfg)
	return &Client{
		base:         gatewayURL,
		agentVersion: agentVersion,
		tlsConfig:    cfg,
		transport:    t,
		http:         h,
		schema:       v,
	}, nil
}

func (c *Client) client() *http.Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.http
}

func noRedirects(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// NewEnrollClient returns a client for enrollment: no client certificate,
// and the gateway's chain must contain a certificate whose SHA-256 is the
// token's root fingerprint; the server certificate is verified against that
// root for serverName and serverAuth. RootSeen returns the pinned root after
// a successful handshake.
func NewEnrollClient(gatewayURL, serverName, rootFingerprint, agentVersion string, v *schema.Validator, now func() time.Time) (*Client, error) {
	cfg := baseTLS(serverName)
	var c *Client
	// Verification is done here, against the pinned fingerprint; Go's
	// default (system roots) is never used.
	cfg.InsecureSkipVerify = true
	cfg.VerifyConnection = func(cs tls.ConnectionState) error {
		if err := requireH2(cs); err != nil {
			return err
		}
		root, err := verifyPinned(cs.PeerCertificates, serverName, rootFingerprint, now())
		if err != nil {
			return err
		}
		c.rootSeen.Store(root)
		return nil
	}
	client, err := newClient(gatewayURL, agentVersion, cfg, v)
	if err != nil {
		return nil, err
	}
	c = client
	return c, nil
}

func verifyPinned(chain []*x509.Certificate, serverName, fingerprint string, now time.Time) (*x509.Certificate, error) {
	if len(chain) == 0 {
		return nil, errors.New("transport: the gateway presented no certificate")
	}
	var root *x509.Certificate
	intermediates := x509.NewCertPool()
	for _, c := range chain[1:] {
		sum := sha256.Sum256(c.Raw)
		if nodecrypto.SameFingerprint("sha256:"+hex.EncodeToString(sum[:]), fingerprint) {
			root = c
			continue
		}
		intermediates.AddCert(c)
	}
	if root == nil {
		return nil, errors.New("transport: the gateway's chain does not contain the pinned root")
	}
	roots := x509.NewCertPool()
	roots.AddCert(root)
	if _, err := chain[0].Verify(x509.VerifyOptions{
		DNSName:       serverName,
		Roots:         roots,
		Intermediates: intermediates,
		CurrentTime:   now,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}); err != nil {
		return nil, fmt.Errorf("transport: gateway certificate: %w", err)
	}
	return root, nil
}

// RootSeen returns the root certificate the enrollment handshake pinned.
func (c *Client) RootSeen() *x509.Certificate { return c.rootSeen.Load() }

// NewSessionClient returns the mTLS client of an enrolled node: the gateway
// is verified against the stored root (serverAuth, serverName), and the node
// presents its current certificate, which SetCertificate replaces on renewal.
func NewSessionClient(gatewayURL, serverName string, root *x509.Certificate, cert tls.Certificate, agentVersion string, v *schema.Validator) (*Client, error) {
	cfg := baseTLS(serverName)
	pool := x509.NewCertPool()
	pool.AddCert(root)
	cfg.RootCAs = pool
	cfg.VerifyConnection = requireH2
	var c *Client
	cfg.GetClientCertificate = func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
		return c.cert.Load(), nil
	}
	client, err := newClient(gatewayURL, agentVersion, cfg, v)
	if err != nil {
		return nil, err
	}
	c = client
	c.cert.Store(&cert)
	return c, nil
}

// SetCertificate swaps the client certificate after renewal. Every later
// request goes over a new connection pool, so it presents the new
// certificate: an HTTP/2 connection is shared by concurrent requests and
// would otherwise never become idle (heartbeats, the claim long poll). The
// old pool's connections are closed once their in-flight requests ended.
func (c *Client) SetCertificate(cert tls.Certificate) {
	c.cert.Store(&cert)
	t, h := newTransport(c.tlsConfig.Clone())
	c.mu.Lock()
	old := c.transport
	c.transport, c.http = t, h
	c.mu.Unlock()
	old.CloseIdleConnections()
	time.AfterFunc(requestTimeout+5*time.Second, old.CloseIdleConnections)
}

// Close closes idle connections.
func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.transport.CloseIdleConnections()
}

// Post sends request (a value that encodes to the named request message) and
// decodes the response into response (the named response message), after
// checking both against their schemas. A non-2xx answer is a *ProtocolError.
func (c *Client) Post(ctx context.Context, endpoint, requestMessage string, request any, responseMessage string, response any, limit int) error {
	data, err := c.PostRaw(ctx, endpoint, requestMessage, request, responseMessage, limit)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(response)
}

// PostRaw is Post returning the response bytes. With responseMessage "" the
// response is only required to be strict JSON; the caller checks it (the
// claim response, whose envelope the verification pipeline judges).
func (c *Client) PostRaw(ctx context.Context, endpoint, requestMessage string, request any, responseMessage string, limit int) ([]byte, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if len(body) > limit {
		return nil, fmt.Errorf("%w: %s request of %d bytes exceeds %d", ErrRequestInvalid, requestMessage, len(body), limit)
	}
	if err := c.check(requestMessage, body); err != nil {
		return nil, fmt.Errorf("%w: refusing to send an invalid %s: %v", ErrRequestInvalid, requestMessage, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HeaderProtocol, protocol.ProtocolID)
	req.Header.Set(HeaderAgentVersion, c.agentVersion)
	resp, err := c.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.ProtoMajor != 2 {
		return nil, fmt.Errorf("transport: the gateway answered over %s, not HTTP/2", resp.Proto)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxResponseBytes {
		return nil, errors.New("transport: response too large")
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, decodeError(resp.StatusCode, data, c)
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		return nil, errors.New("transport: response is not JSON")
	}
	if responseMessage == "" {
		if _, err := canon.Parse(data); err != nil {
			return nil, fmt.Errorf("transport: invalid JSON from the gateway: %w", err)
		}
		return data, nil
	}
	if err := c.check(responseMessage, data); err != nil {
		return nil, fmt.Errorf("transport: invalid %s from the gateway: %w", responseMessage, err)
	}
	return data, nil
}

// check parses data strictly and validates it against the message schema.
func (c *Client) check(message string, data []byte) error {
	v, err := canon.Parse(data)
	if err != nil {
		return err
	}
	ref, ok := c.schema.MessageRef(message)
	if !ok {
		return fmt.Errorf("no message %s", message)
	}
	return c.schema.Validate(ref, v)
}

func decodeError(status int, data []byte, c *Client) error {
	e := &ProtocolError{Status: status, Code: "UNKNOWN", Message: "the gateway answered without a protocol error"}
	if c.check("ProtocolError", data) == nil {
		var body protocol.ProtocolError
		if json.Unmarshal(data, &body) == nil {
			e.Code, e.Message, e.Retryable = body.Code, body.Message, body.Retryable
		}
	}
	return e
}

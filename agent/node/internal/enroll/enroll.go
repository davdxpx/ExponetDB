// Package enroll implements the agent's side of enrollment and certificate
// renewal (enrollment.md §3, §4; protocol.md §7.3, §7.4). The host generates
// all three key pairs; none leaves it. The token secret never travels: the
// agent presents the redeem key and a binding proof derived from it. The
// agent accepts the gateway's answer only if the job-signing keys hash to the
// token's fingerprints and the certificate it issued carries the agent's own
// TLS key, names this node, and chains to the pinned root as a client
// certificate.
package enroll

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
	"github.com/davdxpx/ExponetDB/agent/node/internal/transport"
)

// Options are the inputs of Enroll besides the token.
type Options struct {
	AgentVersion string
	Host         protocol.HostFacts
	Schema       *schema.Validator
	Now          func() time.Time
	// Rand is the key source (crypto/rand unless a test injects one).
	Rand io.Reader
	// Dial overrides the gateway address the token names (tests only).
	Dial string
}

// Result is the state and identity to persist after a successful enrollment.
type Result struct {
	State    *state.State
	Identity *state.Identity
}

func seed(r io.Reader) ([]byte, error) {
	b := make([]byte, 32)
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, err
	}
	return b, nil
}

func zero(bs ...[]byte) {
	for _, b := range bs {
		for i := range b {
			b[i] = 0
		}
	}
}

// Enroll redeems a token and returns the node's state and identity.
func Enroll(ctx context.Context, tokenText string, o Options) (*Result, error) {
	token, reason := nodecrypto.DecodeToken(tokenText)
	if token == nil {
		return nil, fmt.Errorf("enroll: the token is not valid (%s)", reason)
	}
	defer zero(token.Secret)
	if expires, err := time.Parse(time.RFC3339Nano, token.ExpiresAt); err != nil || !o.Now().Before(expires) {
		return nil, errors.New("enroll: the token has expired; create a new one")
	}
	r := o.Rand
	if r == nil {
		r = rand.Reader
	}
	tlsSeed, err := seed(r)
	if err != nil {
		return nil, err
	}
	nskSeed, err := seed(r)
	if err != nil {
		return nil, err
	}
	nekSecret, err := seed(r)
	if err != nil {
		return nil, err
	}
	nek, err := ecdh.X25519().NewPrivateKey(nekSecret)
	if err != nil {
		return nil, err
	}
	tlsKey := nodecrypto.B64U(ed25519.NewKeyFromSeed(tlsSeed).Public().(ed25519.PublicKey))
	nsk := nodecrypto.B64U(ed25519.NewKeyFromSeed(nskSeed).Public().(ed25519.PublicKey))
	nekPub := nodecrypto.B64U(nek.PublicKey().Bytes())

	redeem, bind, err := nodecrypto.TokenKeys(token.Secret, token.TokenID)
	if err != nil {
		return nil, err
	}
	defer zero(redeem, bind)
	tlsProof, err := nodecrypto.SignCanonical(tlsSeed, nodecrypto.TLSKeyProofValue(token.TokenID, tlsKey))
	if err != nil {
		return nil, err
	}
	nskProof, err := nodecrypto.SignCanonical(nskSeed, nodecrypto.NodeSigningKeyProofValue(token.TokenID, nsk))
	if err != nil {
		return nil, err
	}
	bindProof, err := nodecrypto.BindProof(bind, nodecrypto.BindStatement{
		InstallationID:    token.InstallationID,
		ServerID:          token.ServerID,
		TokenID:           token.TokenID,
		NodeSigningKey:    nsk,
		NodeEncryptionKey: nekPub,
	})
	if err != nil {
		return nil, err
	}

	gateway := token.Gateway
	if o.Dial != "" {
		gateway = o.Dial
	}
	client, err := transport.NewEnrollClient(gateway, token.GatewayServerName, token.RootFingerprint, o.AgentVersion, o.Schema, o.Now)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	var resp protocol.EnrollResponse
	if err := client.Post(ctx, transport.EndpointEnroll, "EnrollRequest", protocol.EnrollRequest{
		TokenID:             token.TokenID,
		RedeemKey:           nodecrypto.B64U(redeem),
		TLSKey:              tlsKey,
		TLSKeyProof:         tlsProof,
		NodeSigningKey:      nsk,
		NodeSigningKeyProof: nskProof,
		NodeEncryptionKey:   nekPub,
		BindProof:           bindProof,
		AgentVersion:        o.AgentVersion,
		ProtocolMajors:      []int64{1},
		Host:                o.Host,
	}, "EnrollResponse", &resp, transport.MaxRequestBytes); err != nil {
		return nil, fmt.Errorf("enroll: %w", err)
	}
	root := client.RootSeen()
	if root == nil {
		return nil, errors.New("enroll: no pinned root after the handshake")
	}

	if resp.InstallationID != token.InstallationID || resp.ServerID != token.ServerID {
		return nil, errors.New("enroll: the gateway answered for another installation or server")
	}
	jobKeys, err := anchoredJobKeys(token, resp.JobKeys)
	if err != nil {
		return nil, err
	}
	expires, err := CheckCertificate(resp.CertificateChain, root, token.InstallationID, resp.NodeID, tlsKey, o.Now())
	if err != nil {
		return nil, fmt.Errorf("enroll: %w", err)
	}
	now := o.Now().UTC().Format(time.RFC3339)
	return &Result{
		State: &state.State{
			Schema:            state.StateSchema,
			InstallationID:    token.InstallationID,
			ServerID:          token.ServerID,
			NodeID:            resp.NodeID,
			GatewayURL:        token.Gateway,
			GatewayServerName: token.GatewayServerName,
			RootCertificate:   nodecrypto.B64U(root.Raw),
			RootFingerprint:   token.RootFingerprint,
			JobKeys:           jobKeys,
			EnrolledAt:        now,
		},
		Identity: &state.Identity{
			Schema:               state.IdentitySchema,
			TLSSeed:              nodecrypto.B64U(tlsSeed),
			NodeSigningSeed:      nodecrypto.B64U(nskSeed),
			NodeEncryptionSecret: nodecrypto.B64U(nekSecret),
			CertificateChain:     resp.CertificateChain,
			CertificateExpiresAt: expires.UTC().Format(time.RFC3339),
		},
	}, nil
}

// anchoredJobKeys accepts the gateway's job keys only when they are exactly
// the token's anchors (ADR-0024 §1; Wave 5 correction F8): every anchor once,
// each key hashing to its anchor's fingerprint, no key twice and none the
// token does not name. A part of the anchors is refused too: the Control
// Plane records the token's keys as the node's trust, so a node that kept
// only some would be cut off when another one is activated. Nothing is
// stored before this check passes.
func anchoredJobKeys(token *nodecrypto.EnrollmentToken, keys []protocol.EnrollResponseJobKey) ([]state.JobKey, error) {
	if len(keys) == 0 {
		return nil, errors.New("enroll: no job-signing key")
	}
	seen := make(map[string]bool, len(keys))
	out := make([]state.JobKey, 0, len(keys))
	for _, k := range keys {
		if seen[k.KeyID] {
			return nil, fmt.Errorf("enroll: job key %s is named twice; aborting", k.KeyID)
		}
		seen[k.KeyID] = true
		pub, ok := nodecrypto.FromB64UOf(k.PublicKey, 32)
		if !ok {
			return nil, fmt.Errorf("enroll: job key %s is not a public key", k.KeyID)
		}
		anchored := false
		for _, t := range token.JobKeys {
			if t.KeyID == k.KeyID && nodecrypto.SameFingerprint(nodecrypto.KeyFingerprint(pub), t.Fingerprint) {
				anchored = true
			}
		}
		if !anchored {
			return nil, fmt.Errorf("enroll: job key %s does not match the token; aborting", k.KeyID)
		}
		out = append(out, state.JobKey{KeyID: k.KeyID, PublicKey: k.PublicKey})
	}
	for _, t := range token.JobKeys {
		if !seen[t.KeyID] {
			return nil, fmt.Errorf("enroll: the gateway's job keys do not cover the token's key %s; aborting", t.KeyID)
		}
	}
	return out, nil
}

// CheckCertificate verifies an issued chain: the node certificate carries
// tlsKey, has CN nodeID and the SAN URI of this installation and node, and
// verifies against root as a client certificate (clientAuth through every
// intermediate). It returns the certificate's expiry.
func CheckCertificate(chain []string, root *x509.Certificate, installationID, nodeID, tlsKey string, now time.Time) (time.Time, error) {
	if len(chain) < 2 || !nodecrypto.IsID("nod", nodeID) {
		return time.Time{}, errors.New("certificate chain or node id missing")
	}
	certs := make([]*x509.Certificate, 0, len(chain))
	for _, c := range chain {
		der, ok := nodecrypto.FromB64U(c)
		if !ok {
			return time.Time{}, errors.New("certificate is not base64url")
		}
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			return time.Time{}, err
		}
		certs = append(certs, cert)
	}
	// The chain is the node certificate and the issuing CA, never a root: a
	// self-signed certificate in it would be trusted only through the pinned
	// root anyway, so its presence means a gateway that does not follow the
	// protocol.
	for _, c := range certs {
		if c.Equal(root) || c.CheckSignatureFrom(c) == nil {
			return time.Time{}, errors.New("the certificate chain contains a root")
		}
	}
	leaf := certs[0]
	pub, ok := leaf.PublicKey.(ed25519.PublicKey)
	if !ok || nodecrypto.B64U(pub) != tlsKey {
		return time.Time{}, errors.New("the certificate does not carry this host's TLS key")
	}
	want := "urn:exponet:exponetdb:node:" + installationID + ":" + nodeID
	if leaf.Subject.CommonName != nodeID || len(leaf.URIs) != 1 || leaf.URIs[0].String() != want {
		return time.Time{}, errors.New("the certificate names another node")
	}
	intermediates := x509.NewCertPool()
	for _, c := range certs[1:] {
		intermediates.AddCert(c)
	}
	roots := x509.NewCertPool()
	roots.AddCert(root)
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: intermediates,
		CurrentTime:   now,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err != nil {
		return time.Time{}, err
	}
	return leaf.NotAfter, nil
}

// TLSCertificate builds the client certificate from the identity.
func TLSCertificate(id *state.Identity) (tls.Certificate, error) {
	var out tls.Certificate
	for _, c := range id.CertificateChain {
		der, ok := nodecrypto.FromB64U(c)
		if !ok {
			return out, errors.New("certificate is not base64url")
		}
		out.Certificate = append(out.Certificate, der)
	}
	out.PrivateKey = ed25519.NewKeyFromSeed(state.Seed(id.TLSSeed))
	leaf, err := x509.ParseCertificate(out.Certificate[0])
	if err != nil {
		return out, err
	}
	out.Leaf = leaf
	return out, nil
}

// DueForRenewal reports whether two thirds of the certificate's lifetime
// have passed (enrollment.md §4).
func DueForRenewal(id *state.Identity, now time.Time) (bool, error) {
	cert, err := TLSCertificate(id)
	if err != nil {
		return false, err
	}
	life := cert.Leaf.NotAfter.Sub(cert.Leaf.NotBefore)
	return !now.Before(cert.Leaf.NotBefore.Add(life * 2 / 3)), nil
}

// Renew asks for a new certificate for a new TLS key over the current mTLS
// session and returns the new identity; the caller saves it and swaps the
// client certificate.
func Renew(ctx context.Context, client *transport.Client, st *state.State, id *state.Identity, now time.Time, r io.Reader) (*state.Identity, error) {
	if r == nil {
		r = rand.Reader
	}
	tlsSeed, err := seed(r)
	if err != nil {
		return nil, err
	}
	tlsKey := nodecrypto.B64U(ed25519.NewKeyFromSeed(tlsSeed).Public().(ed25519.PublicKey))
	proof, err := nodecrypto.SignCanonical(tlsSeed, nodecrypto.RenewTLSKeyProofValue(st.NodeID, tlsKey))
	if err != nil {
		return nil, err
	}
	signature, err := nodecrypto.SignCanonical(state.Seed(id.NodeSigningSeed), nodecrypto.RenewSignatureValue(st.NodeID, tlsKey))
	if err != nil {
		return nil, err
	}
	var resp protocol.RenewResponse
	if err := client.Post(ctx, transport.EndpointRenew, "RenewRequest", protocol.RenewRequest{
		NodeID: st.NodeID, TLSKey: tlsKey, TLSKeyProof: proof, NodeSignature: signature,
	}, "RenewResponse", &resp, transport.MaxRequestBytes); err != nil {
		return nil, fmt.Errorf("renew: %w", err)
	}
	rootDER, _ := nodecrypto.FromB64U(st.RootCertificate)
	root, err := x509.ParseCertificate(rootDER)
	if err != nil {
		return nil, err
	}
	expires, err := CheckCertificate(resp.CertificateChain, root, st.InstallationID, st.NodeID, tlsKey, now)
	if err != nil {
		return nil, fmt.Errorf("renew: %w", err)
	}
	next := *id
	next.TLSSeed = nodecrypto.B64U(tlsSeed)
	next.CertificateChain = resp.CertificateChain
	next.CertificateExpiresAt = expires.UTC().Format(time.RFC3339)
	return &next, nil
}

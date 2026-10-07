// Package testpki builds the agent PKI of enrollment.md §2 for tests: an
// Ed25519 root, a gateway server CA limited to serverAuth, an issuing CA
// limited to clientAuth, a gateway server certificate and node client
// certificates. It is imported by tests only.
package testpki

import (
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"math/big"
	"net/url"
	"time"
)

// Cert is a certificate with its key.
type Cert struct {
	Cert *x509.Certificate
	DER  []byte
	Key  crypto.Signer
}

// PKI is a complete test hierarchy.
type PKI struct {
	Root, ServerCA, IssuingCA, Gateway Cert
	Now                                time.Time
}

var serial int64

func issue(template *x509.Certificate, parent *Cert, pub crypto.PublicKey, key crypto.Signer) Cert {
	serial++
	template.SerialNumber = big.NewInt(serial)
	parentCert, parentKey := template, key
	if parent != nil {
		parentCert, parentKey = parent.Cert, parent.Key
	}
	der, err := x509.CreateCertificate(rand.Reader, template, parentCert, pub, parentKey)
	if err != nil {
		panic(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		panic(err)
	}
	return Cert{Cert: cert, DER: der, Key: key}
}

func newKey() ed25519.PrivateKey {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	return key
}

func ca(name string, parent *Cert, now time.Time, eku []x509.ExtKeyUsage) Cert {
	key := newKey()
	return issue(&x509.Certificate{
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
		ExtKeyUsage:           eku,
	}, parent, key.Public(), key)
}

// New builds a hierarchy whose gateway certificate names serverName.
func New(now time.Time, serverName string) *PKI {
	p := &PKI{Now: now}
	p.Root = ca("ExponetDB Agent Root CA (test)", nil, now, nil)
	p.ServerCA = ca("Gateway server CA (test)", &p.Root, now, []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth})
	p.IssuingCA = ca("Agent Issuing CA (test)", &p.Root, now, []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth})
	key := newKey()
	p.Gateway = issue(&x509.Certificate{
		Subject:     pkix.Name{CommonName: serverName},
		DNSNames:    []string{serverName},
		NotBefore:   now.Add(-time.Hour),
		NotAfter:    now.Add(90 * 24 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}, &p.ServerCA, key.Public(), key)
	return p
}

// RootFingerprint is "sha256:" + hex(SHA-256(DER of the root)).
func (p *PKI) RootFingerprint() string {
	sum := sha256.Sum256(p.Root.DER)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// GatewayTLS returns the gateway's server certificate with its full chain
// up to and including the root (enrollment needs the root to pin it).
func (p *PKI) GatewayTLS() tls.Certificate {
	return tls.Certificate{
		Certificate: [][]byte{p.Gateway.DER, p.ServerCA.DER, p.Root.DER},
		PrivateKey:  p.Gateway.Key,
		Leaf:        p.Gateway.Cert,
	}
}

// NodeOptions vary a node certificate for negative tests.
type NodeOptions struct {
	Issuer   *Cert
	CN       string
	URI      string
	Lifetime time.Duration
	EKU      []x509.ExtKeyUsage
}

// Node issues a node client certificate for pub.
func (p *PKI) Node(pub ed25519.PublicKey, installationID, nodeID string, o NodeOptions) Cert {
	issuer := &p.IssuingCA
	if o.Issuer != nil {
		issuer = o.Issuer
	}
	cn := nodeID
	if o.CN != "" {
		cn = o.CN
	}
	uri := "urn:exponet:exponetdb:node:" + installationID + ":" + nodeID
	if o.URI != "" {
		uri = o.URI
	}
	life := 72 * time.Hour
	if o.Lifetime != 0 {
		life = o.Lifetime
	}
	eku := []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	if o.EKU != nil {
		eku = o.EKU
	}
	u, err := url.Parse(uri)
	if err != nil {
		panic(err)
	}
	return issue(&x509.Certificate{
		Subject:     pkix.Name{CommonName: cn},
		URIs:        []*url.URL{u},
		NotBefore:   p.Now.Add(-time.Minute),
		NotAfter:    p.Now.Add(life),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: eku,
	}, issuer, pub, nil)
}

// ClientCAs is the pool the gateway verifies node certificates against.
func (p *PKI) ClientCAs() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(p.Root.Cert)
	return pool
}

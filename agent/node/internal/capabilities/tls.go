package capabilities

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgwire"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

func certFingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func keyType(c *x509.Certificate) string {
	switch k := c.PublicKey.(type) {
	case *ecdsa.PublicKey:
		return "ECDSA " + k.Curve.Params().Name
	case *rsa.PublicKey:
		return "RSA " + strconv.Itoa(k.N.BitLen())
	case ed25519.PublicKey:
		return "Ed25519"
	}
	return "unknown"
}

func summary(c *x509.Certificate) canon.Object {
	dns := canon.Array{}
	for i, n := range c.DNSNames {
		if i == 32 {
			break
		}
		dns = append(dns, canon.String(bound(n, 253)))
	}
	ips := canon.Array{}
	for i, ip := range c.IPAddresses {
		if i == 32 {
			break
		}
		ips = append(ips, canon.String(ip.String()))
	}
	return obj("fingerprint", certFingerprint(c.Raw), "subject", bound(c.Subject.String(), 1024),
		"issuer", bound(c.Issuer.String(), 1024), "dnsNames", dns, "ipAddresses", ips,
		"notBefore", c.NotBefore.UTC().Truncate(time.Second), "notAfter", c.NotAfter.UTC().Truncate(time.Second), "keyType", keyType(c))
}

// serverCertificate reads the first certificate of the server's
// ssl_cert_file.
func serverCertificate(ctx context.Context, c *pgwire.Conn) (*x509.Certificate, string, error) {
	rows, err := c.Query(ctx, `SELECT current_setting('ssl_cert_file') AS cert`)
	if err != nil {
		return nil, "", err
	}
	path := rows.Each()[0].Text("cert")
	data, present, err := readFile(ctx, c, path)
	if err != nil || !present {
		return nil, path, err
	}
	for {
		var b *pem.Block
		b, data = pem.Decode(data)
		if b == nil {
			return nil, path, errors.New("the certificate file holds no certificate")
		}
		if b.Type == "CERTIFICATE" {
			cert, err := x509.ParseCertificate(b.Bytes)
			return cert, path, err
		}
	}
}

// tlsFiles checks that the server reads the TLS files the operator mapped.
func tlsFiles(ctx context.Context, c *pgwire.Conn, in config.Instance) error {
	if in.TLSCertificateFile == "" {
		return preconditionf("the operator did not configure TLS files for cluster %s", in.LocalName)
	}
	rows, err := c.Query(ctx, `SELECT current_setting('ssl_cert_file') AS cert, current_setting('ssl_key_file') AS key`)
	if err != nil {
		return err
	}
	r := rows.Each()[0]
	if r.Text("cert") != in.TLSCertificateFile || r.Text("key") != in.TLSKeyFile {
		return preconditionf("the server reads other TLS files than the operator mapped")
	}
	return nil
}

// ----- postgres.tls.inspect@1 -----

type tlsInspect struct{ clusterBound }

func (p tlsInspect) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	_, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	rows, err := c.Query(ctx, `SELECT current_setting('ssl')::bool AS ssl, current_setting('ssl_min_protocol_version') AS min`)
	if err != nil {
		return nil, err
	}
	r := rows.Each()[0]
	var cert any
	if r.Bool("ssl") {
		x, _, err := serverCertificate(ctx, c)
		if err != nil {
			return nil, err
		}
		if x != nil {
			cert = summary(x)
		}
	}
	var min any
	if v := r.TextOrNil("min"); v != nil {
		min = bound(*v, 16)
	}
	if err := step(run, "inspect"); err != nil {
		return nil, err
	}
	return obj("ssl", r.Bool("ssl"), "minProtocolVersion", min, "certificate", cert), nil
}

// ----- postgres.tls.plan@1 -----

type tlsPlan struct{ clusterBound }

func (p tlsPlan) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	in, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if err := tlsFiles(ctx, c, in); err != nil {
		return nil, err
	}
	staged, err := p.env.Helper.Call(ctx, helperproto.OpTLSGenerateKey, job.Envelope)
	if err != nil {
		return nil, err
	}
	if err := step(run, "generate_key"); err != nil {
		return nil, err
	}
	return obj("stagingId", text(staged, "stagingId"), "publicKey", text(staged, "publicKey"), "proof", text(staged, "proof")), nil
}

// ----- postgres.tls.rotate@1 -----

type tlsRotate struct{ clusterBound }

func (p tlsRotate) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	in, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if err := tlsFiles(ctx, c, in); err != nil {
		return nil, err
	}
	if err := step(run, "check"); err != nil {
		return nil, err
	}
	if err := run.BeginEffect(); err != nil {
		return nil, err
	}
	installed, err := p.env.Helper.Call(ctx, helperproto.OpTLSInstall, job.Envelope)
	if err != nil {
		return nil, err
	}
	if err := step(run, "install"); err != nil {
		return nil, err
	}
	if err := reload(ctx, c); err != nil {
		return nil, err
	}
	if err := step(run, "reload"); err != nil {
		return nil, err
	}
	presented, err := p.env.presentedCertificate(ctx, in)
	if err != nil {
		return nil, fmt.Errorf("no fresh TLS session after the reload: %w", err)
	}
	if certFingerprint(presented) != text(installed, "fingerprint") {
		return nil, errors.New("a fresh TLS session presents another certificate than the one installed")
	}
	if err := step(run, "probe"); err != nil {
		return nil, err
	}
	return obj("fingerprint", text(installed, "fingerprint"), "previousFingerprint", member(installed, "previousFingerprint"),
		"notAfter", text(installed, "notAfter"), "reloaded", true, "presentedFingerprint", certFingerprint(presented)), nil
}

// presentedCertificate opens a TLS session to the instance's TCP port the
// way a client does (SSLRequest, then the handshake) and returns the
// certificate it presents; nothing is trusted or sent beyond the handshake.
func (e *Env) presentedCertificate(ctx context.Context, in config.Instance) ([]byte, error) {
	host := e.TLSHost
	if host == "" {
		host = "127.0.0.1"
	}
	var d net.Dialer
	nc, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(in.Port)))
	if err != nil {
		return nil, err
	}
	defer nc.Close()
	_ = nc.SetDeadline(time.Now().Add(10 * time.Second))
	req := binary.BigEndian.AppendUint32(nil, 8)
	req = binary.BigEndian.AppendUint32(req, 80877103)
	if _, err := nc.Write(req); err != nil {
		return nil, err
	}
	var answer [1]byte
	if _, err := io.ReadFull(nc, answer[:]); err != nil {
		return nil, err
	}
	if answer[0] != 'S' {
		return nil, errors.New("the instance does not offer TLS")
	}
	var presented []byte
	t := tls.Client(nc, &tls.Config{
		MinVersion: tls.VersionTLS12,
		// Only the presented certificate is read; trust is not the question.
		InsecureSkipVerify: true, //nolint:gosec // the fingerprint is compared, nothing is sent
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) > 0 {
				presented = cs.PeerCertificates[0].Raw
			}
			return nil
		},
	})
	if err := t.HandshakeContext(ctx); err != nil {
		return nil, err
	}
	_ = t.Close()
	if presented == nil {
		return nil, errors.New("no certificate presented")
	}
	return presented, nil
}

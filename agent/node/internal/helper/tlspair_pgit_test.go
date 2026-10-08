//go:build pgit

package helper

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsafe"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
)

// pgCluster is a disposable PostgreSQL cluster this test creates with
// initdb in a temporary directory (never a shared or a packaged cluster),
// run by the postgres OS user with TLS on.
type pgCluster struct {
	t        *testing.T
	bin      string
	base     string
	data     string
	port     int
	uid, gid int
}

func (c *pgCluster) keyPath() string  { return filepath.Join(c.base, "tls", "server.key") }
func (c *pgCluster) certPath() string { return filepath.Join(c.base, "tls", "server.crt") }

// run runs a PostgreSQL program as the postgres user (no shell); its output
// goes to a file, never to a pipe the postmaster could keep open.
func (c *pgCluster) run(name string, args ...string) (string, error) {
	out, err := os.CreateTemp(c.base, "out-")
	if err != nil {
		c.t.Fatal(err)
	}
	defer os.Remove(out.Name())
	defer out.Close()
	cmd := exec.Command(filepath.Join(c.bin, name), args...)
	cmd.Dir = c.base
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LC_ALL=C", "LANG=C"}
	cmd.Stdout, cmd.Stderr = out, out
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(c.uid), Gid: uint32(c.gid)}}
	err = cmd.Run()
	text, _ := os.ReadFile(out.Name())
	return string(text), err
}

func (c *pgCluster) logPath() string { return filepath.Join(c.base, "run", "server.log") }

func (c *pgCluster) ctl(action string) error {
	out, err := c.run("pg_ctl", "-D", c.data, "-l", c.logPath(), "-w", "-t", "30", action)
	if err != nil {
		return fmt.Errorf("pg_ctl %s: %v: %s", action, err, out)
	}
	return nil
}

func (c *pgCluster) serverLog() string {
	data, _ := os.ReadFile(c.logPath())
	return string(data)
}

// presented is the certificate a fresh TLS session to the cluster's TCP port
// presents (SSLRequest, then the handshake), as the agent's probe reads it.
func (c *pgCluster) presented() ([]byte, error) {
	nc, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(c.port)), 5*time.Second)
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
		return nil, fmt.Errorf("the cluster does not offer TLS (%q)", answer[0])
	}
	var cert []byte
	s := tls.Client(nc, &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, //nolint:gosec // only the presented certificate is read
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) > 0 {
				cert = cs.PeerCertificates[0].Raw
			}
			return nil
		},
	})
	if err := s.HandshakeContext(context.Background()); err != nil {
		return nil, err
	}
	_ = s.Close()
	return cert, nil
}

// presents waits (a reload is asynchronous) until the cluster presents want.
func (c *pgCluster) presents(want []byte) {
	c.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		got, err := c.presented()
		if err == nil && bytes.Equal(got, want) {
			return
		}
		if time.Now().After(deadline) {
			c.t.Fatalf("the cluster presents another certificate (%v); log:\n%s", err, c.serverLog())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func newPgCluster(t *testing.T, major string) *pgCluster {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Fatal("this test is the root helper's: run it as root (sudo -E go test -tags pgit ./internal/helper)")
	}
	pg, err := user.Lookup("postgres")
	if err != nil {
		t.Fatalf("the postgres OS user: %v", err)
	}
	uid, _ := strconv.Atoi(pg.Uid)
	gid, _ := strconv.Atoi(pg.Gid)
	bin := "/usr/lib/postgresql/" + major + "/bin"
	if _, err := os.Stat(filepath.Join(bin, "initdb")); err != nil {
		t.Fatalf("PostgreSQL %s: %v", major, err)
	}
	base, err := os.MkdirTemp("", "exdb-pgit-tls-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(base, 0o755); err != nil {
		t.Fatal(err)
	}
	c := &pgCluster{t: t, bin: bin, base: base, data: filepath.Join(base, "data"), port: freePort(t), uid: uid, gid: gid}
	t.Cleanup(func() {
		_ = c.ctl("stop")
		_ = os.RemoveAll(base)
	})
	for _, d := range []string{"tls", "run"} {
		p := filepath.Join(base, d)
		if err := os.Mkdir(p, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(p, uid, gid); err != nil {
			t.Fatal(err)
		}
	}
	for _, d := range []string{"state", "state/staging"} {
		if err := os.Mkdir(filepath.Join(base, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chown(base, 0, 0); err != nil {
		t.Fatal(err)
	}
	// initdb as postgres creates the data directory in base (root's, 0755):
	// it needs a directory it owns.
	if err := os.Mkdir(c.data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(c.data, uid, gid); err != nil {
		t.Fatal(err)
	}
	if out, err := c.run("initdb", "-D", c.data, "-A", "trust", "-U", "postgres", "--no-sync"); err != nil {
		t.Fatalf("initdb: %v: %s", err, out)
	}
	conf := fmt.Sprintf("\nlisten_addresses = '127.0.0.1'\nport = %d\nunix_socket_directories = '%s'\n"+
		"ssl = on\nssl_cert_file = '%s'\nssl_key_file = '%s'\n",
		c.port, filepath.Join(base, "run"), c.certPath(), c.keyPath())
	f, err := os.OpenFile(filepath.Join(c.data, "postgresql.conf"), os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(conf); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	return c
}

// pgitHelper is a helper over the cluster's real paths (no test root), with
// its own trust, ledger and state directory, as the helper process opens
// them at its start.
func pgitHelper(t *testing.T, c *pgCluster, in config.Instance, clk *clock.Fixed) *Helper {
	t.Helper()
	stateDir := filepath.Join(c.base, "state")
	ledger, err := journal.OpenLedger(stateDir, "effects.log", clk.Now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ledger.Close() })
	sv, err := schema.Protocol()
	if err != nil {
		t.Fatal(err)
	}
	return &Helper{
		Config: &config.Config{Schema: config.Schema, AgentUser: "exponetdb", Instances: []config.Instance{in}},
		Schema: sv, Clock: clk, Ledger: ledger, Runner: &fakeRunner{out: map[string]Output{}},
		TrustPath: filepath.Join(stateDir, "helper-trust.json"), TrustOwner: 0,
		StagingDirectory: filepath.Join(stateDir, "staging"), StateDirectory: stateDir,
	}
}

func clusterOf(in config.Instance, sysid string) canon.Object {
	return canon.Object{
		{Name: "localName", Value: canon.String(in.LocalName)},
		{Name: "systemIdentifier", Value: canon.String(sysid)},
	}
}

// TestTLSPairOnPostgreSQL: on a real cluster of each major version, an
// installation interrupted between the key and the certificate (the mixed
// pair PostgreSQL keeps out at a reload and refuses to start with) is
// settled by the recovery of a restarted helper, and PostgreSQL reloads and
// restarts with the result: the previous pair when the certificate was not
// yet in place, the new pair when both were; a complete installation is
// accepted too. The interruption is an error injected at every step from
// the rename on (the process-kill test is TestTLSPairCrashAtEveryStep).
func TestTLSPairOnPostgreSQL(t *testing.T) {
	for _, major := range []string{"16", "17", "18"} {
		t.Run("PostgreSQL "+major, func(t *testing.T) {
			c := newPgCluster(t, major)
			now := time.Now().UTC().Truncate(time.Second)
			clk := &clock.Fixed{T: now, Synced: true}
			ca := newCA(t, now)
			// The previous pair, as the operator installed it.
			k0, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
			der0, _ := x509.MarshalPKCS8PrivateKey(k0)
			cert0 := ca.issue(t, &k0.PublicKey, now)
			for _, f := range []struct {
				path string
				data []byte
				mode os.FileMode
			}{{c.keyPath(), pemOf("PRIVATE KEY", der0), 0o600}, {c.certPath(), pemOf("CERTIFICATE", cert0), 0o644}} {
				if err := os.WriteFile(f.path, f.data, f.mode); err != nil {
					t.Fatal(err)
				}
				if err := os.Chown(f.path, c.uid, c.gid); err != nil {
					t.Fatal(err)
				}
			}
			if err := c.ctl("start"); err != nil {
				t.Fatalf("%v\n%s", err, c.serverLog())
			}
			c.presents(cert0)

			in := config.Instance{
				LocalName: major + "/pgittls", Unit: "postgresql@" + major + "-pgittls.service", Port: c.port,
				SocketDirectory: filepath.Join(c.base, "run"), DataDirectory: c.data,
				ConfigFile: filepath.Join(c.data, "postgresql.conf"), HbaFile: filepath.Join(c.data, "pg_hba.conf"),
				ManagedInclude:     filepath.Join(c.data, "conf.d", "90-exponetdb.conf"),
				TLSCertificateFile: c.certPath(), TLSKeyFile: c.keyPath(),
			}
			pub := nodecrypto.B64U(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey))
			if err := SaveTrust(filepath.Join(c.base, "state", "helper-trust.json"), &Trust{
				Schema: TrustSchema, InstallationID: installation, NodeID: node,
				JobKeys: []state.JobKey{{KeyID: keyID, PublicKey: pub}},
			}); err != nil {
				t.Fatal(err)
			}
			h := pgitHelper(t, c, in, clk)
			sysid, err := h.systemIdentifier(c.data)
			if err != nil {
				t.Fatal(err)
			}
			e := &env{t: t, h: h, clk: clk, runner: h.Runner.(*fakeRunner), in: in}
			ref := clusterOf(in, sysid)
			rotation := func() ([]byte, []byte, []byte) {
				plan := e.mustCall(OpTLSGenerateKey, e.job("postgres.tls.plan", canon.Object{
					{Name: "cluster", Value: ref}, {Name: "dnsNames", Value: canon.Array{canon.String("db.internal")}},
					{Name: "ipAddresses", Value: canon.Array{}},
				}))
				point, _ := nodecrypto.FromB64UOf(str(plan, "publicKey"), 65)
				p, _ := nodecrypto.ParseP256PublicKey(point)
				leaf := ca.issue(t, p, now)
				current, _ := c.presented()
				args := rotateArgs(str(plan, "stagingId"), str(plan, "publicKey"), [][]byte{leaf, ca.cert.Raw}, canon.String(fingerprint(current)))
				args[0].Value = ref
				staged, err := os.ReadFile(filepath.Join(h.StagingDirectory, str(plan, "stagingId")+stagedKeySuffix))
				if err != nil {
					t.Fatal(err)
				}
				return e.job("postgres.tls.rotate", args), leaf, staged
			}
			restart := func() {
				_ = e.h.Ledger.Close()
				e.h = pgitHelper(t, c, in, clk)
				h = e.h
			}
			failFrom := func(name string) {
				failing := false
				fsafe.FaultHook = func(s fsafe.Step, _, n string) error {
					failing = failing || (s == fsafe.AfterRename && n == name)
					if failing {
						return errInjected
					}
					return nil
				}
			}
			defer func() { fsafe.FaultHook = nil }()

			// 1. Interrupted between the key and the certificate: the new key
			// next to the previous certificate, which PostgreSQL refuses.
			job1, _, key1 := rotation()
			failFrom("server.key")
			if _, refusal := e.call(OpTLSInstall, job1); refusal == nil || refusal.Code != CodeOutcomeUnknown {
				t.Fatalf("refusal %+v", refusal)
			}
			fsafe.FaultHook = nil
			if key, _ := os.ReadFile(c.keyPath()); !bytes.Equal(key, key1) {
				t.Fatal("setup: the new key is not in place")
			}
			// A reload keeps the pair PostgreSQL has loaded; a start refuses.
			if err := c.ctl("reload"); err != nil {
				t.Fatal(err)
			}
			time.Sleep(time.Second)
			c.presents(cert0)
			if err := c.ctl("restart"); err == nil {
				t.Fatal("PostgreSQL started with a key that is not its certificate's")
			}
			refused := ""
			for _, line := range strings.Split(c.serverLog(), "\n") {
				if strings.Contains(line, "private key") {
					refused = line
				}
			}
			if refused == "" {
				t.Fatalf("PostgreSQL refused for another reason:\n%s", c.serverLog())
			}
			t.Logf("PostgreSQL %s with the mixed pair: %s", major, refused)
			// The helper starts again: the recovery puts the previous pair back.
			restart()
			did, err := h.SettleTLSInstall()
			if err != nil || !strings.Contains(did, "undone") {
				t.Fatalf("recovery: %q %v", did, err)
			}
			if err := c.ctl("start"); err != nil {
				t.Fatalf("%v\n%s", err, c.serverLog())
			}
			c.presents(cert0)
			if err := c.ctl("reload"); err != nil {
				t.Fatal(err)
			}
			c.presents(cert0)
			e.mustRefuse(OpTLSInstall, job1, CodeReplayed)

			// 2. Interrupted after both renames, before the directory syncs:
			// the recovery completes the new pair.
			job2, leaf2, _ := rotation()
			failFrom("server.crt")
			if _, refusal := e.call(OpTLSInstall, job2); refusal == nil || refusal.Code != CodeOutcomeUnknown {
				t.Fatalf("refusal %+v", refusal)
			}
			fsafe.FaultHook = nil
			restart()
			if did, err := h.SettleTLSInstall(); err != nil || !strings.Contains(did, "completed") {
				t.Fatalf("recovery: %q %v", did, err)
			}
			if err := c.ctl("reload"); err != nil {
				t.Fatal(err)
			}
			c.presents(leaf2)
			if err := c.ctl("restart"); err != nil {
				t.Fatalf("%v\n%s", err, c.serverLog())
			}
			c.presents(leaf2)
			e.mustRefuse(OpTLSInstall, job2, CodeReplayed)

			// 3. A complete installation: PostgreSQL takes the files the
			// helper wrote (key 0600 and certificate 0644 of postgres).
			job3, leaf3, _ := rotation()
			e.mustCall(OpTLSInstall, job3)
			if err := c.ctl("reload"); err != nil {
				t.Fatal(err)
			}
			c.presents(leaf3)
			if err := c.ctl("restart"); err != nil {
				t.Fatalf("%v\n%s", err, c.serverLog())
			}
			c.presents(leaf3)
			if _, err := os.Stat(filepath.Join(c.base, "state", pairRecordName)); !os.IsNotExist(err) {
				t.Fatalf("the record is left: %v", err)
			}
		})
	}
}

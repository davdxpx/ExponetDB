//go:build pgit

package capabilities

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helper"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/kdigest"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgfiles"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgtest"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

const (
	installationID = "ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	nodeID         = "nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	operationID    = "op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	jobKeyID       = "jobkey_test"
)

var jobSeed = bytes.Repeat([]byte{5}, 32)

type syncedClock struct{}

func (syncedClock) Now() time.Time              { return time.Now() }
func (syncedClock) Synchronized() (bool, error) { return true, nil }

// hostRunner is systemd where the host has it (CI), and on a host without
// systemd the test's stand-in: a restart of a postgresql@ unit through
// pg_ctlcluster, no failed units. The evidence names which one ran.
type hostRunner struct{ systemd bool }

func (r hostRunner) Run(ctx context.Context, c helper.Command) (helper.Output, error) {
	if r.systemd {
		return helper.ExecRunner{}.Run(ctx, c)
	}
	if c.Path == helper.Systemctl && len(c.Args) == 3 && c.Args[0] == "restart" {
		unit := strings.TrimSuffix(strings.TrimPrefix(c.Args[2], "postgresql@"), ".service")
		major, name, _ := strings.Cut(unit, "-")
		out, err := exec.CommandContext(ctx, "pg_ctlcluster", major, name, "restart").CombinedOutput()
		if err != nil {
			return helper.Output{Stdout: out, ExitCode: 1}, nil
		}
		return helper.Output{}, nil
	}
	return helper.Output{}, nil
}

type inProcess struct{ h *helper.Helper }

func (p inProcess) Call(ctx context.Context, op string, envelope canon.Object) (canon.Object, error) {
	job, err := canon.Canonicalize(envelope)
	if err != nil {
		return nil, err
	}
	req, _ := json.Marshal(helperproto.Request{V: helperproto.Version, Op: op, Job: job})
	resp := p.h.Handle(ctx, req)
	if resp.Error != nil {
		return nil, resp.Error
	}
	v, err := canon.Parse(resp.Result)
	if err != nil {
		return nil, err
	}
	return v.(canon.Object), nil
}

type harness struct {
	t      *testing.T
	env    *Env
	caps   map[string]agent.Capability
	schema *schema.Validator
	seq    int
	nek    *ecdh.PrivateKey
	in     config.Instance
}

func newHarness(t *testing.T, in config.Instance) *harness {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Fatal("the capability integration tests run as root (the helper's part writes PostgreSQL's files)")
	}
	dir := t.TempDir()
	_ = os.Chmod(dir, 0o755)
	staging := filepath.Join(dir, "staging")
	if err := os.Mkdir(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	trustPath := filepath.Join(dir, "helper-trust.json")
	pub := ed25519.NewKeyFromSeed(jobSeed).Public().(ed25519.PublicKey)
	if err := helper.SaveTrust(trustPath, &helper.Trust{Schema: helper.TrustSchema, InstallationID: installationID,
		NodeID: nodeID, JobKeys: []state.JobKey{{KeyID: jobKeyID, PublicKey: nodecrypto.B64U(pub)}}}); err != nil {
		t.Fatal(err)
	}
	ledger, err := journal.OpenLedger(dir, "effects.log", time.Now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ledger.Close() })
	sv, err := schema.Protocol()
	if err != nil {
		t.Fatal(err)
	}
	// Restarts are not spaced here; TestRestartIsObservable proves the spacing.
	unspaced := 0
	cfg := &config.Config{Schema: config.Schema, StateDirectory: "/var/lib/exponetdb-node",
		HelperSocket: "/run/exponetdb-node-helper/helper.sock", AgentUser: "exponetdb", Instances: []config.Instance{in},
		RestartIntervalSeconds: &unspaced}
	_, systemd := os.Stat("/run/systemd/system")
	h := &helper.Helper{Config: cfg, Schema: sv, Clock: syncedClock{}, Ledger: ledger, Runner: hostRunner{systemd: systemd == nil},
		TrustPath: trustPath, TrustOwner: 0, StagingDirectory: staging,
		DigestKey: bytes.Repeat([]byte{0x3c}, kdigest.KeySize)}
	nek, _ := ecdh.X25519().GenerateKey(rand.Reader)
	digestKey, err := kdigest.AgentKey(nek.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	env := &Env{Config: cfg, Helper: inProcess{h}, Clock: syncedClock{}, DigestKey: digestKey}
	caps := map[string]agent.Capability{}
	for _, c := range All(env) {
		caps[c.Key()] = c
	}
	return &harness{t: t, env: env, caps: caps, schema: sv, nek: nek, in: in}
}

func (h *harness) cluster() canon.Object {
	c, err := h.env.connect(context.Background(), h.in, "")
	if err != nil {
		h.t.Fatal(err)
	}
	defer c.Close()
	rows, err := c.Query(context.Background(), `SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()`)
	if err != nil {
		h.t.Fatal(err)
	}
	return obj("localName", h.in.LocalName, "systemIdentifier", rows.Each()[0].Text("id"))
}

// splitKey splits name@major.
func splitKey(key string) (string, int) {
	name, m, _ := strings.Cut(key, "@")
	major, _ := strconv.Atoi(m)
	return name, major
}

// job signs a job of capability key (name@major) for args.
func (h *harness) job(key string, args canon.Object) *verify.Job {
	h.t.Helper()
	h.seq++
	name, major := splitKey(key)
	b, _ := canon.Canonicalize(args)
	sum := sha256.Sum256(b)
	now := time.Now().UTC()
	e := canon.Object{
		{Name: "jobId", Value: canon.String(fmt.Sprintf("job_01JB2Z6G8M4Q7R9T1V3W%06d", h.seq))},
		{Name: "operationId", Value: canon.String(operationID)},
		{Name: "nodeId", Value: canon.String(nodeID)},
		{Name: "capability", Value: canon.Object{{Name: "name", Value: canon.String(name)}, {Name: "major", Value: canon.Number(major)}}},
		{Name: "args", Value: args},
		{Name: "argsHash", Value: canon.String("sha256:" + hex.EncodeToString(sum[:]))},
		{Name: "notBefore", Value: canon.String(now.Add(-time.Second).Format(time.RFC3339))},
		{Name: "expiresAt", Value: canon.String(now.Add(15 * time.Minute).Format(time.RFC3339))},
		{Name: "nonce", Value: canon.String(nodecrypto.B64U(append([]byte{byte(h.seq), byte(h.seq >> 8)}, bytes.Repeat([]byte{9}, 14)...)))},
		{Name: "issuedAt", Value: canon.String(now.Add(-time.Second).Format(time.RFC3339))},
		{Name: "attempt", Value: canon.Number(1)},
	}
	signed, err := nodecrypto.SignJobEnvelope(e, jobKeyID, jobSeed)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := h.schema.ValidateArgs(key, args); err != nil {
		h.t.Fatalf("%s args: %v", key, err)
	}
	job, ok := verify.Facts(signed)
	if !ok {
		h.t.Fatal("unreadable envelope")
	}
	return job
}

// seal seals a value to the harness's node key for job's field.
func (h *harness) seal(jobID, key, field string, plaintext []byte) canon.Object {
	name, major := splitKey(key)
	s, err := nodecrypto.SealNs1(h.nek.PublicKey().Bytes(), nodecrypto.SealContext{InstallationID: installationID, NodeID: nodeID,
		JobID: jobID, OperationID: operationID, Capability: name, Major: major, Field: field}, plaintext)
	if err != nil {
		h.t.Fatal(err)
	}
	return obj("ns1", obj("enc", s.Enc, "ct", s.CT))
}

// run checks the precondition, runs the capability and checks its result
// against the contract schema.
func (h *harness) run(key string, job *verify.Job) (canon.Object, error) {
	h.t.Helper()
	c := h.caps[key]
	if err := c.Precondition(job.Args); err != nil {
		return nil, err
	}
	run := agent.NewRun(c.EffectStep(), time.Now, func(field string, value canon.Value) ([]byte, bool) {
		return verify.OpenSealed(h.nek.Bytes(), installationID, job, field, value)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	out, err := c.Run(ctx, job, run)
	if err != nil {
		return nil, err
	}
	if err := h.schema.ValidateResult(key, out); err != nil {
		h.t.Fatalf("%s result outside its schema: %v\n%s", key, err, mustJSON(out))
	}
	return out, nil
}

func (h *harness) must(key string, args canon.Object) canon.Object {
	h.t.Helper()
	out, err := h.run(key, h.job(key, args))
	if err != nil {
		h.t.Fatalf("%s: %v", key, err)
	}
	return out
}

func mustJSON(v canon.Value) string { b, _ := canon.Canonicalize(v); return string(b) }

func (h *harness) sql(q string, args ...any) []string {
	h.t.Helper()
	c, err := h.env.connect(context.Background(), h.in, "")
	if err != nil {
		h.t.Fatal(err)
	}
	defer c.Close()
	rows, err := c.Query(context.Background(), q, args...)
	if err != nil {
		h.t.Fatalf("%s: %v", q, err)
	}
	var out []string
	for _, r := range rows.Values {
		if len(r) > 0 && r[0] != nil {
			out = append(out, *r[0])
		} else {
			out = append(out, "")
		}
	}
	return out
}

func eachMajor(t *testing.T, fn func(t *testing.T, h *harness)) {
	for _, in := range pgtest.Instances(t) {
		t.Run(in.LocalName, func(t *testing.T) { fn(t, newHarness(t, in)) })
	}
}

func TestCatalogCoversTheContract(t *testing.T) {
	sv, _ := schema.Protocol()
	env := &Env{Config: &config.Config{}}
	have := map[string]bool{"agent.diagnostics@2": true, "config.update@1": true}
	for _, c := range All(env) {
		have[c.Key()] = true
		if _, _, ok := sv.CapabilityRefs(c.Key()); !ok {
			t.Errorf("%s is not in the contract", c.Key())
		}
	}
	for _, key := range []string{"postgres.status@1", "postgres.reload@2", "postgres.restart.plan@2", "postgres.restart@1",
		"postgres.config.inspect@2", "postgres.config.plan@2", "postgres.config.apply@2", "postgres.hba.inspect@2",
		"postgres.hba.apply@2", "postgres.tls.inspect@1", "postgres.tls.plan@1", "postgres.tls.rotate@1",
		"postgres.roles.inspect@2", "postgres.roles.plan@2", "postgres.roles.apply@2", "postgres.extensions.inspect@1",
		"postgres.extensions.apply@1", "system.health@1", "system.reboot_required@1", "disk.stats@1", "memory.stats@1",
		"cpu.stats@1", "service.status@1", "log.inspect@2", "wal.status@1", "wal.archive_status@1", "packages.audit@1",
		"packages.plan_update@1"} {
		if !have[key] {
			t.Errorf("%s is not implemented", key)
		}
	}
}

func TestStatusReadsAndIdentity(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		st := h.must("postgres.status@1", obj("cluster", cl))
		if !boolOf(st, "running") || !strings.HasPrefix(text(st, "version"), h.in.LocalName[:2]) {
			t.Fatalf("%s", mustJSON(st))
		}
		// Another system identifier: refused before anything runs.
		other := obj("localName", h.in.LocalName, "systemIdentifier", "1")
		if _, err := h.run("postgres.reload@2", h.job("postgres.reload@2", obj("cluster", other))); !errors.Is(err, ErrPrecondition) {
			t.Fatalf("another cluster: %v", err)
		}
		h.must("postgres.restart.plan@2", obj("cluster", cl))
		h.must("wal.status@1", obj("cluster", cl))
		h.must("wal.archive_status@1", obj("cluster", cl))
		disk := h.must("disk.stats@1", obj("cluster", cl))
		if len(list(disk, "breakdown")) != 4 {
			t.Fatalf("%s", mustJSON(disk))
		}
		h.must("disk.stats@1", obj("cluster", nil))
		h.must("memory.stats@1", obj())
		h.must("cpu.stats@1", obj())
		h.must("system.reboot_required@1", obj())
		h.must("system.health@1", obj())
		reload := h.must("postgres.reload@2", obj("cluster", cl))
		if len(list(reload, "fileErrors")) != 0 {
			t.Fatalf("%s", mustJSON(reload))
		}
		// The reload is in the server log, redacted and filtered.
		since := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
		until := time.Now().Add(time.Minute).UTC().Format(time.RFC3339)
		logs := h.must("log.inspect@2", obj("source", "postgresql", "cluster", cl, "since", since, "until", until,
			"minSeverity", "info", "maxLines", 50))
		found := false
		for _, l := range list(logs, "lines") {
			found = found || strings.Contains(text(l.(canon.Object), "text"), "SIGHUP")
		}
		if !found {
			t.Fatalf("no reload in the log: %s", mustJSON(logs))
		}
	})
}

func TestRestartIsObservable(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		out := h.must("postgres.restart@1", obj("cluster", cl, "shutdownMode", "fast"))
		before, _ := time.Parse(time.RFC3339Nano, text(out, "postmasterStartTimeBefore"))
		after, _ := time.Parse(time.RFC3339Nano, text(out, "postmasterStartTimeAfter"))
		if !after.After(before) || !boolOf(out, "acceptingConnections") {
			t.Fatalf("%s", mustJSON(out))
		}
		// The same job again: the helper refuses the replay.
		job := h.job("postgres.restart@1", obj("cluster", cl, "shutdownMode", "fast"))
		if _, err := h.run("postgres.restart@1", job); err != nil {
			t.Fatal(err)
		}
		var refusal *helperproto.ErrorBody
		if _, err := h.run("postgres.restart@1", job); !errors.As(err, &refusal) || refusal.Code != helperproto.CodeReplayed {
			t.Fatalf("replay: %v", err)
		}
		// Spaced restarts: a new job within the interval is refused and the
		// postmaster keeps running.
		started := text(h.must("postgres.status@1", obj("cluster", cl)), "postmasterStartTime")
		spaced := 600
		h.env.Config.RestartIntervalSeconds = &spaced
		defer func() { h.env.Config.RestartIntervalSeconds = nil }()
		if _, err := h.run("postgres.restart@1", h.job("postgres.restart@1", obj("cluster", cl, "shutdownMode", "fast"))); !errors.As(err, &refusal) ||
			refusal.Code != helperproto.CodeFailed || !strings.Contains(refusal.Message, "allows one per 10m0s") {
			t.Fatalf("spacing: %v", err)
		}
		if again := text(h.must("postgres.status@1", obj("cluster", cl)), "postmasterStartTime"); again != started {
			t.Fatalf("the postmaster restarted: %s, then %s", started, again)
		}
	})
}

func TestConfigurationThroughTheManagedFragment(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		inspect := h.must("postgres.config.inspect@2", obj("cluster", cl))
		include, _ := member(inspect, "managedInclude").(canon.Object)
		if !boolOf(include, "included") {
			t.Fatalf("the Debian conf.d include is not seen: %s", mustJSON(include))
		}
		// A planned change: valid, invalid, out of range, unknown, restart.
		plan := h.must("postgres.config.plan@2", obj("cluster", cl, "changes", canon.Array{
			obj("name", "work_mem", "value", "24MB"),
			obj("name", "work_mem_typo", "value", "1"),
			obj("name", "max_connections", "value", "57"),
			obj("name", "statement_timeout", "value", "-5"),
			obj("name", "log_min_messages", "value", "loud"),
		}))
		reasons := map[string]string{}
		for _, p := range list(plan, "parameters") {
			o := p.(canon.Object)
			reasons[text(o, "name")] = text(o, "invalidReason") + "/" + text(o, "effect")
		}
		want := map[string]string{"work_mem": "/reload", "work_mem_typo": "unknown_parameter/none",
			"max_connections": "/restart", "statement_timeout": "out_of_range/reload", "log_min_messages": "invalid_value/reload"}
		for k, v := range want {
			if reasons[k] != v {
				t.Errorf("%s: %s, want %s", k, reasons[k], v)
			}
		}
		// ALTER SYSTEM would win over the fragment: shown as a conflict.
		h.sql(`ALTER SYSTEM SET work_mem = '8MB'`)
		conflict := h.must("postgres.config.plan@2", obj("cluster", cl, "changes", canon.Array{obj("name", "work_mem", "value", "24MB")}))
		if text(list(conflict, "parameters")[0].(canon.Object), "conflict") != "auto_conf_overrides" {
			t.Fatalf("%s", mustJSON(conflict))
		}
		h.sql(`ALTER SYSTEM RESET work_mem`)
		// Apply: the fragment is written by the helper and reloaded.
		inspect = h.must("postgres.config.inspect@2", obj("cluster", cl))
		include, _ = member(inspect, "managedInclude").(canon.Object)
		apply := obj("cluster", cl, "changes", canon.Array{obj("name", "work_mem", "value", "24MB")},
			"expectedFragmentDigest", member(include, "digest"), "configVersion", text(inspect, "configVersion"), "reload", true)
		out := h.must("postgres.config.apply@2", apply)
		if !boolOf(out, "reloaded") || h.sql(`SELECT current_setting('work_mem')`)[0] != "24MB" {
			t.Fatalf("%s", mustJSON(out))
		}
		// The same plan again is stale.
		if _, err := h.run("postgres.config.apply@2", h.job("postgres.config.apply@2", apply)); !errors.Is(err, ErrPrecondition) {
			t.Fatalf("a stale apply ran: %v", err)
		}
		// Back to the server's default (an empty fragment).
		inspect = h.must("postgres.config.inspect@2", obj("cluster", cl))
		include, _ = member(inspect, "managedInclude").(canon.Object)
		h.must("postgres.config.apply@2", obj("cluster", cl, "changes", canon.Array{obj("name", "work_mem", "value", nil)},
			"expectedFragmentDigest", member(include, "digest"), "configVersion", text(inspect, "configVersion"), "reload", true))
	})
}

func TestHbaKeepsExponetDBsOwnAccess(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		protected := canon.Array{obj("role", "exponetdb_node", "database", "postgres", "address", "local", "method", "peer")}
		inspect := h.must("postgres.hba.inspect@2", obj("cluster", cl))
		original, _, _ := readFileAs(h, h.in.HbaFile)
		// A block that would lock ExponetDB out: refused, the file restored.
		lockout := obj("cluster", cl, "managedRules", canon.Array{
			obj("type", "local", "database", canon.Array{canon.String("all")}, "user", canon.Array{canon.String("all")},
				"address", nil, "method", "reject", "map", nil),
		}, "expectedFileDigest", text(inspect, "fileDigest"), "protectedAccess", protected)
		if _, err := h.run("postgres.hba.apply@2", h.job("postgres.hba.apply@2", lockout)); err == nil ||
			!strings.Contains(err.Error(), "restored") {
			t.Fatalf("a lockout was applied: %v", err)
		}
		if now, _, _ := readFileAs(h, h.in.HbaFile); !bytes.Equal(now, original) {
			t.Fatal("pg_hba.conf was not restored")
		}
		// The agent's own access is kept even when the plan does not name it.
		appOnly := canon.Array{obj("role", "app_user", "database", "app", "address", "10.1.0.5", "method", "scram-sha-256")}
		agentOut := obj("cluster", cl, "managedRules", canon.Array{
			obj("type", "local", "database", canon.Array{canon.String("all")}, "user", canon.Array{canon.String("exponetdb_node")},
				"address", nil, "method", "reject", "map", nil),
			obj("type", "hostssl", "database", canon.Array{canon.String("app")}, "user", canon.Array{canon.String("app_user")},
				"address", "10.1.0.0/16", "method", "scram-sha-256", "map", nil),
		}, "expectedFileDigest", text(inspect, "fileDigest"), "protectedAccess", appOnly)
		if _, err := h.run("postgres.hba.apply@2", h.job("postgres.hba.apply@2", agentOut)); err == nil ||
			!strings.Contains(err.Error(), "agent's own access") || !strings.Contains(err.Error(), "restored") {
			t.Fatalf("the agent's own access was not protected: %v", err)
		}
		if now, _, _ := readFileAs(h, h.in.HbaFile); !bytes.Equal(now, original) {
			t.Fatal("pg_hba.conf was not restored")
		}
		// A block that keeps the access: written, reloaded, probed.
		ok := obj("cluster", cl, "managedRules", canon.Array{
			obj("type", "hostssl", "database", canon.Array{canon.String("app")}, "user", canon.Array{canon.String("app_user")},
				"address", "10.1.0.0/16", "method", "scram-sha-256", "map", nil),
		}, "expectedFileDigest", text(inspect, "fileDigest"), "protectedAccess", protected)
		out := h.must("postgres.hba.apply@2", ok)
		if !boolOf(out, "reloaded") {
			t.Fatalf("%s", mustJSON(out))
		}
		after := h.must("postgres.hba.inspect@2", obj("cluster", cl))
		block, _ := member(after, "managedBlock").(canon.Object)
		if !boolOf(block, "present") {
			t.Fatalf("%s", mustJSON(after))
		}
		// Put the operator's file back for the next run.
		writeFileAs(h, h.in.HbaFile, original)
		h.sql(`SELECT pg_catalog.pg_reload_conf()`)
	})
}

func TestTLSRotationPresentsTheNewCertificate(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		before := h.must("postgres.tls.inspect@1", obj("cluster", cl))
		cert, _ := member(before, "certificate").(canon.Object)
		plan := h.must("postgres.tls.plan@1", obj("cluster", cl, "dnsNames", canon.Array{canon.String("db.exdb.test")}, "ipAddresses", canon.Array{}))
		point, _ := nodecrypto.FromB64UOf(text(plan, "publicKey"), 65)
		pub, _ := nodecrypto.ParseP256PublicKey(point)
		caKey, _ := ecdsa.GenerateKey(pub.Curve, rand.Reader)
		caTmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test PostgreSQL CA"},
			NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true,
			KeyUsage: x509.KeyUsageCertSign}
		caDER, _ := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
		ca, _ := x509.ParseCertificate(caDER)
		leafDER, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{SerialNumber: big.NewInt(2),
			Subject: pkix.Name{CommonName: "db.exdb.test"}, DNSNames: []string{"db.exdb.test"},
			NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(12 * time.Hour),
			ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}, ca, pub, caKey)
		if err != nil {
			t.Fatal(err)
		}
		out := h.must("postgres.tls.rotate@1", obj("cluster", cl, "stagingId", text(plan, "stagingId"), "publicKey", text(plan, "publicKey"),
			"certificateChain", canon.Array{canon.String(nodecrypto.B64U(leafDER)), canon.String(nodecrypto.B64U(caDER))},
			"expectedCurrentFingerprint", text(cert, "fingerprint")))
		if text(out, "presentedFingerprint") != text(out, "fingerprint") || text(out, "previousFingerprint") != text(cert, "fingerprint") {
			t.Fatalf("%s", mustJSON(out))
		}
	})
}

// scram computes a SCRAM-SHA-256 verifier (RFC 5802/7677) for the test.
func scram(password string) string {
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	salted, _ := pbkdf2.Key(sha256.New, password, salt, 4096, 32)
	mac := func(key []byte, msg string) []byte {
		m := hmac.New(sha256.New, key)
		m.Write([]byte(msg))
		return m.Sum(nil)
	}
	clientKey := mac(salted, "Client Key")
	stored := sha256.Sum256(clientKey)
	server := mac(salted, "Server Key")
	b := base64.StdEncoding.EncodeToString
	return "SCRAM-SHA-256$4096:" + b(salt) + "$" + b(stored[:]) + ":" + b(server)
}

func TestGrantsThatEscalateOrWidenAreRefused(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		for _, r := range []string{"exdb_esc_user", "exdb_esc_group", "exdb_esc_feed", "exponetdb_esc_own"} {
			h.sql(`DROP ROLE IF EXISTS ` + r)
		}
		h.sql(`CREATE ROLE exdb_esc_user LOGIN`)
		h.sql(`CREATE ROLE exdb_esc_group NOLOGIN`)
		h.sql(`CREATE ROLE exdb_esc_feed NOLOGIN`)
		h.sql(`CREATE ROLE exponetdb_esc_own NOLOGIN`)
		defer func() {
			h.sql(`REVOKE pg_write_all_data FROM pg_monitor`)
			for _, r := range []string{"exdb_esc_user", "exdb_esc_group", "exdb_esc_feed", "exponetdb_esc_own"} {
				h.sql(`DROP ROLE IF EXISTS ` + r)
			}
		}()
		// A group that reaches a superuser only through its own membership.
		h.sql(`GRANT ` + pgIdent(h.sql(`SELECT rolname FROM pg_catalog.pg_roles WHERE oid = 10`)[0]) + ` TO exdb_esc_group`)
		// A role one of ExponetDB's roles is a member of.
		h.sql(`GRANT exdb_esc_feed TO exponetdb_esc_own`)
		digest := func() string {
			return text(h.must("postgres.roles.inspect@2", obj("cluster", cl, "expectSettings", canon.Array{})), "rolesDigest")
		}
		grant := func(group, memberRole string) error {
			step := obj("op", "grant_membership", "role", group, "attributes", nil, "verifier", nil, "member", memberRole,
				"admin", false, "inherit", true, "set", true, "database", nil, "setting", nil, "value", nil)
			_, err := h.run("postgres.roles.apply@2", h.job("postgres.roles.apply@2",
				obj("cluster", cl, "expectedRolesDigest", digest(), "steps", canon.Array{step})))
			return err
		}
		for _, c := range []struct{ group, member, why string }{
			{"exdb_esc_group", "exdb_esc_user", "a group that is a member of a superuser"},
			{"pg_write_all_data", "pg_monitor", "a predefined role as member"},
			{"exdb_esc_group", "exdb_esc_feed", "a role ExponetDB's role is a member of"},
			{"pg_read_all_data", "exdb_esc_feed", "a role ExponetDB's role is a member of"},
		} {
			if err := grant(c.group, c.member); !errors.Is(err, ErrPrecondition) {
				t.Fatalf("%s: granted (%v)", c.why, err)
			}
		}
		if got := h.sql(`SELECT pg_catalog.pg_has_role('exdb_esc_user', 'exdb_esc_group', 'MEMBER')`); got[0] != "f" {
			t.Fatal("the refused grant is in the catalog")
		}
		// The plan refuses the same membership.
		bad := canon.Array{obj("name", "exdb_esc_user", "attributes", obj("login", true, "inherit", true, "createdb", nil, "createrole", nil,
			"replication", nil, "bypassrls", nil, "connectionLimit", nil),
			"memberOf", canon.Array{obj("role", "exdb_esc_group", "admin", false, "inherit", true, "set", true)},
			"settings", canon.Array{}, "passwordChange", false)}
		if _, err := h.run("postgres.roles.plan@2", h.job("postgres.roles.plan@2", obj("cluster", cl, "roles", bad))); !errors.Is(err, ErrPrecondition) {
			t.Fatalf("a membership reaching a superuser was planned: %v", err)
		}
		// An ordinary grant still works.
		h.sql(`REVOKE ` + pgIdent(h.sql(`SELECT rolname FROM pg_catalog.pg_roles WHERE oid = 10`)[0]) + ` FROM exdb_esc_group`)
		if err := grant("exdb_esc_group", "exdb_esc_user"); err != nil {
			t.Fatal(err)
		}
	})
}

// The plan classifies a grant or a setting by what it hands on, not by its
// name (Wave 5 correction review): a group that reaches a predefined role
// only through its own membership, and a parameter only a superuser may set
// (a role setting the agent stores is applied with its authority at that
// role's login), are critical. A role or session_authorization setting
// hands on nothing: PostgreSQL checks it at login, so it never changes who
// the session is beyond what a membership with SET already allows.
func TestRolesPlanClassifiesWhatIsHandedOn(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		roles := []string{"exdb_cls_user", "exdb_cls_reader", "exdb_cls_plain"}
		drop := func() {
			for _, r := range roles {
				h.sql(`DROP ROLE IF EXISTS ` + r)
			}
		}
		drop()
		defer drop()
		const login = "exdb-cls-login-4d1"
		h.sql(`CREATE ROLE exdb_cls_user LOGIN PASSWORD '` + login + `'`)
		h.sql(`CREATE ROLE exdb_cls_reader NOLOGIN`)
		h.sql(`GRANT pg_read_all_data TO exdb_cls_reader`)
		h.sql(`CREATE ROLE exdb_cls_plain NOLOGIN`)
		member := func(group string) canon.Object {
			return obj("role", group, "admin", false, "inherit", true, "set", true)
		}
		setting := func(name, value string) canon.Object { return obj("name", name, "value", value, "database", nil) }
		plan := h.must("postgres.roles.plan@2", obj("cluster", cl, "roles", canon.Array{obj("name", "exdb_cls_user",
			"attributes", obj("login", true, "inherit", true, "createdb", nil, "createrole", nil, "replication", nil,
				"bypassrls", nil, "connectionLimit", nil),
			"memberOf", canon.Array{member("exdb_cls_reader"), member("exdb_cls_plain")},
			"settings", canon.Array{setting("lo_compat_privileges", "on"), setting("search_path", "app"),
				setting("exdb.tenant", "t1"), setting("role", "exdb_cls_reader")},
			"passwordChange", false)}))
		got := map[string]string{}
		for _, c := range list(plan, "changes") {
			o := c.(canon.Object)
			got[text(o, "detail")] = text(o, "classification")
		}
		want := map[string]string{
			"member of exdb_cls_reader (admin false, inherit true, set true)": "critical",
			"member of exdb_cls_plain (admin false, inherit true, set true)":  "standard",
			"set lo_compat_privileges":                                        "critical",
			"set search_path":                                                 "standard",
			"set exdb.tenant":                                                 "critical",
			"set role":                                                        "critical",
		}
		for detail, class := range want {
			if got[detail] != class {
				t.Errorf("%s: %q, want %q (%v)", detail, got[detail], class, got)
			}
		}

		// What PostgreSQL does with the settings at login.
		whoami := func() string {
			cmd := exec.Command("psql", "-Atc", "SELECT current_user || ',' || session_user || ',' || current_setting('lo_compat_privileges')",
				fmt.Sprintf("host=127.0.0.1 port=%d user=exdb_cls_user dbname=postgres", h.in.Port))
			cmd.Env = append(os.Environ(), "PGPASSWORD="+login)
			out, err := cmd.Output()
			if err != nil {
				t.Fatalf("psql: %v", err)
			}
			return strings.TrimSpace(string(out))
		}
		superuser := h.sql(`SELECT rolname FROM pg_catalog.pg_roles WHERE oid = 10`)[0]
		h.sql(`ALTER ROLE exdb_cls_user SET lo_compat_privileges = on`)
		h.sql(`ALTER ROLE exdb_cls_user SET role = 'exdb_cls_reader'`)
		h.sql(`ALTER ROLE exdb_cls_user SET session_authorization = ` + pgIdent(superuser))
		// The superuser-only setting takes effect for the role; the identity
		// settings do not, without a membership that allows SET.
		if w := whoami(); w != "exdb_cls_user,exdb_cls_user,on" {
			t.Fatalf("not a member: %s", w)
		}
		h.sql(`GRANT exdb_cls_reader TO exdb_cls_user WITH SET FALSE`)
		if w := whoami(); w != "exdb_cls_user,exdb_cls_user,on" {
			t.Fatalf("a member without SET: %s", w)
		}
	})
}

func pgIdent(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }

func TestRolesWithASealedVerifier(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		h.sql(`DROP ROLE IF EXISTS exdb_app_user`)
		h.sql(`DROP ROLE IF EXISTS exdb_app_group`)
		h.sql(`CREATE ROLE exdb_app_group NOLOGIN`)
		// The cluster samples every transaction of the agent's role for the
		// log, with its bind parameters: the apply turns that off for its
		// session before it begins.
		h.sql(`ALTER ROLE CURRENT_USER SET log_transaction_sample_rate = 1`)
		h.sql(`ALTER ROLE CURRENT_USER SET log_min_duration_sample = 0`)
		defer h.sql(`ALTER ROLE CURRENT_USER RESET log_transaction_sample_rate`)
		defer h.sql(`ALTER ROLE CURRENT_USER RESET log_min_duration_sample`)
		desired := canon.Array{obj("name", "exdb_app_user",
			"attributes", obj("login", true, "inherit", true, "createdb", nil, "createrole", nil, "replication", nil, "bypassrls", nil, "connectionLimit", 5),
			"memberOf", canon.Array{obj("role", "exdb_app_group", "admin", false, "inherit", true, "set", true)},
			"settings", canon.Array{obj("name", "statement_timeout", "value", "30s", "database", nil)},
			"passwordChange", true)}
		plan := h.must("postgres.roles.plan@2", obj("cluster", cl, "roles", desired))
		kinds := []string{}
		for _, c := range list(plan, "changes") {
			kinds = append(kinds, text(c.(canon.Object), "change"))
		}
		if strings.Join(kinds, ",") != "create_role,set_password,grant_membership,set_role_setting" {
			t.Fatalf("%v", kinds)
		}
		verifier := scram("correct horse battery staple")
		null := func(names ...string) []any {
			var out []any
			for _, n := range names {
				out = append(out, n, nil)
			}
			return out
		}
		stepOf := func(pairs ...any) canon.Object { return obj(pairs...) }
		args := func(jobID string) canon.Object {
			return obj("cluster", cl, "expectedRolesDigest", text(plan, "rolesDigest"), "steps", canon.Array{
				stepOf(append([]any{"op", "create_role", "role", "exdb_app_user", "attributes",
					obj("login", true, "inherit", true, "createdb", nil, "createrole", nil, "replication", nil, "bypassrls", nil, "connectionLimit", 5)},
					null("verifier", "member", "admin", "inherit", "set", "database", "setting", "value")...)...),
				stepOf(append([]any{"op", "set_password", "role", "exdb_app_user", "verifier",
					h.seal(jobID, "postgres.roles.apply@2", "verifier", []byte(verifier))},
					null("attributes", "member", "admin", "inherit", "set", "database", "setting", "value")...)...),
				stepOf(append([]any{"op", "grant_membership", "role", "exdb_app_group", "member", "exdb_app_user",
					"admin", false, "inherit", true, "set", true}, null("attributes", "verifier", "database", "setting", "value")...)...),
				stepOf(append([]any{"op", "set_role_setting", "role", "exdb_app_user", "setting", "statement_timeout", "value", "30s"},
					null("attributes", "verifier", "member", "admin", "inherit", "set", "database")...)...),
			})
		}
		jobID := fmt.Sprintf("job_01JB2Z6G8M4Q7R9T1V3W%06d", h.seq+1)
		job := h.job("postgres.roles.apply@2", args(jobID))
		out, err := h.run("postgres.roles.apply@2", job)
		if err != nil {
			t.Fatal(err)
		}
		if n, _ := member(out, "appliedSteps").(canon.Number); n != 4 {
			t.Fatalf("%s", mustJSON(out))
		}
		// Compared by digest: this check's own session is sampled for the log too.
		sum := sha256.Sum256([]byte(verifier))
		if got := h.sql(`SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(rolpassword, 'UTF8')), 'hex') = $1
			FROM pg_catalog.pg_authid WHERE rolname = 'exdb_app_user'`, hex.EncodeToString(sum[:])); got[0] != "t" {
			t.Fatal("the verifier was not installed as sealed")
		}
		if got := h.sql(`SELECT count(*) FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
			WHERE r.rolname = 'exdb_app_user' AND 'statement_timeout=30s' = ANY(s.setconfig)`); got[0] != "1" {
			t.Fatal("the role setting is missing")
		}
		// The verifier is in no log and no statement text.
		name, _ := clusterRef(job.Args)
		major, clusterName, _ := strings.Cut(name, "/")
		logData, _ := os.ReadFile("/var/log/postgresql/postgresql-" + major + "-" + clusterName + ".log")
		if bytes.Contains(logData, []byte(verifier)) {
			t.Fatal("the verifier reached the server log")
		}
		// A stale plan, a superuser-equivalent grant: refused.
		if _, err := h.run("postgres.roles.apply@2", h.job("postgres.roles.apply@2", args("job_01JB2Z6G8M4Q7R9T1V3W999999"))); !errors.Is(err, ErrPrecondition) {
			t.Fatalf("a stale roles plan ran: %v", err)
		}
		bad := canon.Array{obj("name", "exdb_app_user", "attributes", obj("login", true, "inherit", true, "createdb", nil, "createrole", nil,
			"replication", nil, "bypassrls", nil, "connectionLimit", nil),
			"memberOf", canon.Array{obj("role", "pg_execute_server_program", "admin", false, "inherit", true, "set", true)},
			"settings", canon.Array{}, "passwordChange", false)}
		if _, err := h.run("postgres.roles.plan@2", h.job("postgres.roles.plan@2", obj("cluster", cl, "roles", bad))); !errors.Is(err, ErrPrecondition) {
			t.Fatalf("a superuser-equivalent membership was planned: %v", err)
		}
		h.sql(`DROP ROLE exdb_app_user`)
		h.sql(`DROP ROLE exdb_app_group`)
	})
}

func TestExtensions(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		h.sql(`DROP EXTENSION IF EXISTS pgcrypto`)
		inspect := h.must("postgres.extensions.inspect@1", obj("cluster", cl, "database", "postgres"))
		version := ""
		for _, a := range list(inspect, "available") {
			if text(a.(canon.Object), "name") == "pgcrypto" {
				version = text(a.(canon.Object), "defaultVersion")
			}
		}
		if version == "" {
			t.Fatal("pgcrypto is not available")
		}
		missing := obj("cluster", cl, "database", "postgres", "expectedExtensionsDigest", text(inspect, "extensionsDigest"),
			"steps", canon.Array{obj("op", "create", "name", "pgcrypto", "schema", "public", "version", "99.9")})
		if _, err := h.run("postgres.extensions.apply@1", h.job("postgres.extensions.apply@1", missing)); !errors.Is(err, ErrPrecondition) {
			t.Fatalf("a missing version was created: %v", err)
		}
		out := h.must("postgres.extensions.apply@1", obj("cluster", cl, "database", "postgres",
			"expectedExtensionsDigest", text(inspect, "extensionsDigest"),
			"steps", canon.Array{obj("op", "create", "name", "pgcrypto", "schema", "public", "version", version)}))
		found := false
		for _, e := range list(out, "installed") {
			found = found || text(e.(canon.Object), "name") == "pgcrypto"
		}
		if !found {
			t.Fatalf("%s", mustJSON(out))
		}
		h.sql(`DROP EXTENSION pgcrypto`)
	})
}

// readFileAs and writeFileAs touch PostgreSQL's files as the test (root).
func readFileAs(h *harness, path string) ([]byte, bool, error) {
	b, err := os.ReadFile(path)
	return b, err == nil, err
}

func writeFileAs(h *harness, path string, data []byte) {
	if err := os.WriteFile(path, data, 0o640); err != nil {
		h.t.Fatal(err)
	}
	_ = pgfiles.Digest(data)
}

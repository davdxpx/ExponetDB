package helper

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgfiles"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
)

const (
	installation = "ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	node         = "nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	otherNode    = "nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Y"
	operationID  = "op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z"
	sysid        = "7291840123456789012"
	keyID        = "jobkey_2026_10"
)

var seed = bytes.Repeat([]byte{3}, 32)

// fakeRunner answers commands with canned output and records them.
type fakeRunner struct {
	out   map[string]Output
	calls []Command
}

func (f *fakeRunner) Run(_ context.Context, c Command) (Output, error) {
	f.calls = append(f.calls, c)
	if o, ok := f.out[c.Path]; ok {
		return o, nil
	}
	return Output{}, nil
}

type env struct {
	t       testing.TB
	h       *Helper
	root    string
	clk     *clock.Fixed
	runner  *fakeRunner
	in      config.Instance
	seq     int
	dataUID int
}

func newEnv(t testing.TB) *env {
	t.Helper()
	root := t.TempDir()
	clk := &clock.Fixed{T: time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC), Synced: true}
	in := config.Instance{
		LocalName: "17/main", Unit: "postgresql@17-main.service", Port: 5432,
		SocketDirectory: "/run/postgresql", DataDirectory: "/var/lib/postgresql/17/main",
		ConfigFile: "/etc/postgresql/17/main/postgresql.conf", HbaFile: "/etc/postgresql/17/main/pg_hba.conf",
		ManagedInclude:     "/etc/postgresql/17/main/conf.d/90-exponetdb.conf",
		TLSCertificateFile: "/etc/postgresql/17/main/server.crt", TLSKeyFile: "/etc/postgresql/17/main/server.key",
	}
	for _, d := range []string{in.DataDirectory + "/global", "/etc/postgresql/17/main/conf.d", "/state/staging"} {
		if err := os.MkdirAll(root+d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	control := make([]byte, 8192)
	var id uint64
	fmt.Sscan(sysid, &id)
	binary.NativeEndian.PutUint64(control, id)
	if err := os.WriteFile(root+in.DataDirectory+"/global/pg_control", control, 0o600); err != nil {
		t.Fatal(err)
	}
	dataUID := os.Geteuid()
	if dataUID == 0 {
		dataUID = 1234
		if err := os.Chown(root+in.DataDirectory, dataUID, dataUID); err != nil {
			t.Fatal(err)
		}
	}
	trustPath := filepath.Join(root, "state", "helper-trust.json")
	pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	if err := SaveTrust(trustPath, &Trust{
		Schema: TrustSchema, InstallationID: installation, NodeID: node,
		JobKeys: []state.JobKey{{KeyID: keyID, PublicKey: nodecrypto.B64U(pub)}},
	}); err != nil {
		t.Fatal(err)
	}
	ledger, err := journal.OpenLedger(filepath.Join(root, "state"), "effects.log", clk.Now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ledger.Close() })
	sv, err := schema.Protocol()
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{out: map[string]Output{}}
	cfg := &config.Config{
		Schema: config.Schema, StateDirectory: "/var/lib/exponetdb-node", HelperSocket: "/run/exponetdb-node/helper.sock",
		AgentUser: "exponetdb", Instances: []config.Instance{in},
	}
	h := &Helper{
		Config: cfg, Schema: sv, Clock: clk, Ledger: ledger, Runner: runner,
		TrustPath: trustPath, TrustOwner: os.Geteuid(), StagingDirectory: root + "/state/staging", Root: root,
	}
	return &env{t: t, h: h, root: root, clk: clk, runner: runner, in: in, dataUID: dataUID}
}

func cluster() canon.Object {
	return canon.Object{
		{Name: "localName", Value: canon.String("17/main")},
		{Name: "systemIdentifier", Value: canon.String(sysid)},
	}
}

type jobOpt func(canon.Object) canon.Object

func set(name string, v canon.Value) jobOpt {
	return func(e canon.Object) canon.Object {
		for i := range e {
			if e[i].Name == name {
				e[i].Value = v
			}
		}
		return e
	}
}

// job signs an envelope for capability name@1 with args.
func (e *env) job(name string, args canon.Object, opts ...jobOpt) []byte {
	e.t.Helper()
	e.seq++
	b, err := canon.Canonicalize(args)
	if err != nil {
		e.t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	now := e.clk.T
	envelope := canon.Object{
		{Name: "jobId", Value: canon.String(fmt.Sprintf("job_01JB2Z6G8M4Q7R9T1V3W5X7Y%02d", e.seq))},
		{Name: "operationId", Value: canon.String(operationID)},
		{Name: "nodeId", Value: canon.String(node)},
		{Name: "capability", Value: canon.Object{{Name: "name", Value: canon.String(name)}, {Name: "major", Value: canon.Number(1)}}},
		{Name: "args", Value: args},
		{Name: "argsHash", Value: canon.String("sha256:" + hex.EncodeToString(sum[:]))},
		{Name: "notBefore", Value: canon.String(now.Format(time.RFC3339))},
		{Name: "expiresAt", Value: canon.String(now.Add(15 * time.Minute).Format(time.RFC3339))},
		{Name: "nonce", Value: canon.String(nodecrypto.B64U(append([]byte{byte(e.seq)}, bytes.Repeat([]byte{7}, 15)...)))},
		{Name: "issuedAt", Value: canon.String(now.Format(time.RFC3339))},
		{Name: "attempt", Value: canon.Number(1)},
	}
	for _, o := range opts {
		envelope = o(envelope)
	}
	signed, err := nodecrypto.SignJobEnvelope(envelope, keyID, seed)
	if err != nil {
		e.t.Fatal(err)
	}
	out, err := canon.Canonicalize(signed)
	if err != nil {
		e.t.Fatal(err)
	}
	return out
}

func (e *env) call(op string, job []byte) (canon.Object, *ErrorBody) {
	e.t.Helper()
	req, _ := json.Marshal(Request{V: Version, Op: op, Job: job})
	resp := e.h.Handle(context.Background(), req)
	if resp.Error != nil {
		return nil, resp.Error
	}
	v, err := canon.Parse(resp.Result)
	if err != nil {
		e.t.Fatal(err)
	}
	return v.(canon.Object), nil
}

func (e *env) mustCall(op string, job []byte) canon.Object {
	e.t.Helper()
	r, refusal := e.call(op, job)
	if refusal != nil {
		e.t.Fatalf("%s refused: %s %s", op, refusal.Code, refusal.Message)
	}
	return r
}

func (e *env) mustRefuse(op string, job []byte, code string) {
	e.t.Helper()
	_, refusal := e.call(op, job)
	if refusal == nil || refusal.Code != code {
		e.t.Fatalf("%s: want %s, got %+v", op, code, refusal)
	}
}

func str(o canon.Object, name string) string {
	v, _ := o.Get(name)
	s, _ := v.(canon.String)
	return string(s)
}

func restartArgs() canon.Object {
	return canon.Object{{Name: "cluster", Value: cluster()}, {Name: "shutdownMode", Value: canon.String("fast")}}
}

func TestJobVerification(t *testing.T) {
	e := newEnv(t)
	op := OpServiceRestart
	// A capability the operation does not serve.
	e.mustRefuse(op, e.job("postgres.reload", canon.Object{{Name: "cluster", Value: cluster()}}), CodeOperationMismatch)
	// Another node.
	e.mustRefuse(op, e.job("postgres.restart", restartArgs(), set("nodeId", canon.String(otherNode))), CodeJobInvalid)
	// Outside the window.
	e.mustRefuse(op, e.job("postgres.restart", restartArgs(),
		set("expiresAt", canon.String(e.clk.T.Add(-time.Minute).Format(time.RFC3339))),
		set("notBefore", canon.String(e.clk.T.Add(-10*time.Minute).Format(time.RFC3339)))), CodeJobInvalid)
	// A tampered envelope (signed, then changed).
	tampered := bytes.Replace(e.job("postgres.restart", restartArgs()), []byte(`"attempt":1`), []byte(`"attempt":2`), 1)
	e.mustRefuse(op, tampered, CodeJobInvalid)
	// argsHash that does not match the arguments.
	e.mustRefuse(op, e.job("postgres.restart", restartArgs(),
		set("argsHash", canon.String("sha256:"+strings.Repeat("0", 64)))), CodeJobInvalid)
	// Invalid arguments.
	e.mustRefuse(op, e.job("postgres.restart", canon.Object{{Name: "cluster", Value: cluster()},
		{Name: "shutdownMode", Value: canon.String("immediate")}}), CodeJobInvalid)
	// An unsynchronized clock.
	e.clk.Synced = false
	e.mustRefuse(op, e.job("postgres.restart", restartArgs()), CodeJobInvalid)
	e.clk.Synced = true
	// A capability the operator disabled.
	e.h.Config.DisabledCapabilities = []string{"postgres.restart@1"}
	e.mustRefuse(op, e.job("postgres.restart", restartArgs()), CodeOperationMismatch)
	e.h.Config.DisabledCapabilities = nil
	// A key the helper does not trust: the agent's trust is not the helper's.
	if err := SaveTrust(e.h.TrustPath, &Trust{Schema: TrustSchema, InstallationID: installation, NodeID: node,
		JobKeys: []state.JobKey{{KeyID: "jobkey_other", PublicKey: nodecrypto.B64U(bytes.Repeat([]byte{1}, 32))}}}); err != nil {
		t.Fatal(err)
	}
	e.mustRefuse(op, e.job("postgres.restart", restartArgs()), CodeJobInvalid)
	if len(e.runner.calls) != 0 {
		t.Fatalf("a refused job ran %v", e.runner.calls)
	}
}

func TestRequestShape(t *testing.T) {
	e := newEnv(t)
	job := e.job("postgres.restart", restartArgs())
	for _, req := range []string{
		`{"v":"exponetdb.helper/v1","op":"service.restart","job":` + string(job) + `,"argv":["sh"]}`,
		`{"v":"exponetdb.helper/v2","op":"service.restart","job":` + string(job) + `}`,
		`{"v":"exponetdb.helper/v1","op":"shell","job":` + string(job) + `}`,
		`{"v":"exponetdb.helper/v1","op":"service.restart","op":"service.status","job":` + string(job) + `}`,
		`[]`, `{}`, ``,
	} {
		resp := e.h.Handle(context.Background(), []byte(req))
		if resp.Error == nil || resp.Error.Code != CodeRequestInvalid {
			t.Fatalf("%.80s: %+v", req, resp)
		}
	}
}

func TestOneEffectPerJob(t *testing.T) {
	e := newEnv(t)
	job := e.job("postgres.restart", restartArgs())
	r := e.mustCall(OpServiceRestart, job)
	if str(r, "unit") != "postgresql@17-main.service" {
		t.Fatalf("result %v", r)
	}
	c := e.runner.calls[0]
	if c.Path != Systemctl || strings.Join(c.Args, " ") != "restart -- postgresql@17-main.service" {
		t.Fatalf("argv %v", c)
	}
	e.mustRefuse(OpServiceRestart, job, CodeReplayed)
	if len(e.runner.calls) != 1 {
		t.Fatal("a replayed job ran again")
	}
}

func TestSystemIdentifierIsTheHelpersOwnCheck(t *testing.T) {
	e := newEnv(t)
	other := canon.Object{
		{Name: "localName", Value: canon.String("17/main")},
		{Name: "systemIdentifier", Value: canon.String("7291840123456789013")},
	}
	e.mustRefuse(OpServiceRestart, e.job("postgres.restart", canon.Object{{Name: "cluster", Value: other},
		{Name: "shutdownMode", Value: canon.String("fast")}}), CodePreconditionFailed)
	unmapped := canon.Object{
		{Name: "localName", Value: canon.String("16/main")},
		{Name: "systemIdentifier", Value: canon.String(sysid)},
	}
	e.mustRefuse(OpServiceRestart, e.job("postgres.restart", canon.Object{{Name: "cluster", Value: unmapped},
		{Name: "shutdownMode", Value: canon.String("fast")}}), CodeNotConfigured)
	if len(e.runner.calls) != 0 {
		t.Fatal("a mismatched cluster was restarted")
	}
}

func fragmentArgs(expected canon.Value, params ...[2]string) canon.Object {
	list := canon.Array{}
	for _, p := range params {
		list = append(list, canon.Object{{Name: "name", Value: canon.String(p[0])}, {Name: "value", Value: canon.String(p[1])}})
	}
	return canon.Object{
		{Name: "cluster", Value: cluster()},
		{Name: "parameters", Value: list},
		{Name: "expectedFragmentDigest", Value: expected},
		{Name: "configVersion", Value: canon.String("sha256:" + strings.Repeat("a", 64))},
		{Name: "reload", Value: canon.Bool(true)},
	}
}

func TestConfigFragment(t *testing.T) {
	e := newEnv(t)
	path := e.root + e.in.ManagedInclude
	// The plan saw a fragment that is not there.
	e.mustRefuse(OpConfigWriteFragment, e.job("postgres.config.apply",
		fragmentArgs(canon.String("sha256:"+strings.Repeat("b", 64)), [2]string{"work_mem", "64MB"})), CodePreconditionFailed)
	r := e.mustCall(OpConfigWriteFragment, e.job("postgres.config.apply",
		fragmentArgs(canon.Null{}, [2]string{"work_mem", "64MB"}, [2]string{"search_path", `"$user", it's\x`})))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := pgfiles.FragmentHeader + "work_mem = '64MB'\nsearch_path = '\"$user\", it''s\\\\x'\n"
	if string(data) != want || str(r, "fragmentDigest") != pgfiles.Digest(data) {
		t.Fatalf("fragment %q, result %v", data, r)
	}
	if v, _ := r.Get("previousFragmentDigest"); v != (canon.Null{}) {
		t.Fatalf("previous %v", v)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o640 || ownerOf(info) != e.dataUID {
		t.Fatalf("mode %v owner %d", info.Mode(), ownerOf(info))
	}
	// Null now means "no fragment", which no longer holds.
	e.mustRefuse(OpConfigWriteFragment, e.job("postgres.config.apply",
		fragmentArgs(canon.Null{}, [2]string{"work_mem", "8MB"})), CodePreconditionFailed)
	r = e.mustCall(OpConfigWriteFragment, e.job("postgres.config.apply",
		fragmentArgs(canon.String(pgfiles.Digest(data)), [2]string{"work_mem", "8MB"})))
	if str(r, "previousFragmentDigest") != pgfiles.Digest(data) {
		t.Fatalf("result %v", r)
	}
	if prev, _ := os.ReadFile(path + ".exponetdb-previous"); !bytes.Equal(prev, data) {
		t.Fatal("the previous fragment was not kept")
	}
}

func TestSymlinksAreRefused(t *testing.T) {
	e := newEnv(t)
	// The fragment itself a symlink to a file root would otherwise write.
	target := filepath.Join(e.root, "shadow")
	_ = os.WriteFile(target, []byte("secret\n"), 0o600)
	if err := os.Symlink(target, e.root+e.in.ManagedInclude); err != nil {
		t.Fatal(err)
	}
	e.mustRefuse(OpConfigWriteFragment, e.job("postgres.config.apply",
		fragmentArgs(canon.Null{}, [2]string{"work_mem", "64MB"})), CodePreconditionFailed)
	_ = os.Remove(e.root + e.in.ManagedInclude)
	// A directory on the path a symlink.
	confd := e.root + "/etc/postgresql/17/main/conf.d"
	_ = os.Remove(confd)
	if err := os.Symlink(e.root+"/elsewhere", confd); err != nil {
		t.Fatal(err)
	}
	_ = os.MkdirAll(e.root+"/elsewhere", 0o700)
	e.mustRefuse(OpConfigWriteFragment, e.job("postgres.config.apply",
		fragmentArgs(canon.Null{}, [2]string{"work_mem", "64MB"})), CodePreconditionFailed)
	if data, _ := os.ReadFile(target); string(data) != "secret\n" {
		t.Fatal("a symlink target was written")
	}
	if _, err := os.Stat(e.root + "/elsewhere/90-exponetdb.conf"); err == nil {
		t.Fatal("a symlinked directory was written")
	}
}

func hbaArgsFor(digest string, rules ...canon.Object) canon.Object {
	list := canon.Array{}
	for _, r := range rules {
		list = append(list, r)
	}
	return canon.Object{
		{Name: "cluster", Value: cluster()},
		{Name: "managedRules", Value: list},
		{Name: "expectedFileDigest", Value: canon.String(digest)},
		{Name: "protectedAccess", Value: canon.Array{canon.Object{
			{Name: "role", Value: canon.String("exponetdb_agent")},
			{Name: "database", Value: canon.String("postgres")},
			{Name: "address", Value: canon.String("local")},
			{Name: "method", Value: canon.String("peer")},
		}}},
	}
}

func rule(typ, db, user string, address canon.Value, method string, mapName canon.Value) canon.Object {
	return canon.Object{
		{Name: "type", Value: canon.String(typ)},
		{Name: "database", Value: canon.Array{canon.String(db)}},
		{Name: "user", Value: canon.Array{canon.String(user)}},
		{Name: "address", Value: address},
		{Name: "method", Value: canon.String(method)},
		{Name: "map", Value: mapName},
	}
}

func TestHbaWriteAndRestore(t *testing.T) {
	e := newEnv(t)
	path := e.root + e.in.HbaFile
	foreign := "# operator lines\nlocal all postgres peer\nhost all all 10.0.0.0/8 scram-sha-256\n"
	if err := os.WriteFile(path, []byte(foreign), 0o640); err != nil {
		t.Fatal(err)
	}
	rules := []canon.Object{
		rule("local", "all", "exponetdb_agent", canon.Null{}, "peer", canon.String("exponetdb")),
		rule("hostssl", "app", "app_user", canon.String("10.1.0.0/16"), "scram-sha-256", canon.Null{}),
	}
	stale := e.job("postgres.hba.apply", hbaArgsFor("sha256:"+strings.Repeat("c", 64), rules...))
	e.mustRefuse(OpHbaWrite, stale, CodePreconditionFailed)
	// The failed precondition did not consume the job's effect.
	job := e.job("postgres.hba.apply", hbaArgsFor(pgfiles.Digest([]byte(foreign)), rules...))
	// A restore before the write is refused.
	e.mustRefuse(OpHbaRestore, job, CodeReplayed)
	r := e.mustCall(OpHbaWrite, job)
	data, _ := os.ReadFile(path)
	block := pgfiles.BeginMarker + ": written by exponetdb-node-helper, do not edit\n" +
		"local all \"exponetdb_agent\" peer map=exponetdb\n" +
		"hostssl \"app\" \"app_user\" 10.1.0.0/16 scram-sha-256\n" + pgfiles.EndMarker + "\n"
	if string(data) != block+foreign || str(r, "fileDigest") != pgfiles.Digest(data) ||
		str(r, "previousFileDigest") != pgfiles.Digest([]byte(foreign)) {
		t.Fatalf("file %q result %v", data, r)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v", info.Mode())
	}
	// Restore puts the previous file back, once.
	e.mustCall(OpHbaRestore, job)
	if data, _ := os.ReadFile(path); string(data) != foreign {
		t.Fatalf("restored %q", data)
	}
	e.mustRefuse(OpHbaRestore, job, CodeReplayed)
	e.mustRefuse(OpHbaWrite, job, CodeReplayed)
	// A second write replaces the block in place; the operator's edit since
	// the write stops a restore.
	second := e.job("postgres.hba.apply", hbaArgsFor(pgfiles.Digest([]byte(foreign)), rules[0]))
	e.mustCall(OpHbaWrite, second)
	data, _ = os.ReadFile(path)
	_ = os.WriteFile(path, append(data, []byte("local all ops peer\n")...), 0o640)
	e.mustRefuse(OpHbaRestore, second, CodePreconditionFailed)
}

func TestHbaAmbiguousMarkersAreRefused(t *testing.T) {
	e := newEnv(t)
	content := pgfiles.BeginMarker + "\nlocal all a peer\n" + pgfiles.BeginMarker + "\n" + pgfiles.EndMarker + "\n"
	_ = os.WriteFile(e.root+e.in.HbaFile, []byte(content), 0o640)
	e.mustRefuse(OpHbaWrite, e.job("postgres.hba.apply", hbaArgsFor(pgfiles.Digest([]byte(content)),
		rule("local", "all", "a", canon.Null{}, "peer", canon.Null{}))), CodePreconditionFailed)
	if data, _ := os.ReadFile(e.root + e.in.HbaFile); string(data) != content {
		t.Fatal("an ambiguous file was changed")
	}
}

func TestServiceStatus(t *testing.T) {
	e := newEnv(t)
	e.runner.out[Systemctl] = Output{Stdout: []byte(
		"Id=postgresql@17-main.service\nLoadState=loaded\nActiveState=active\nSubState=running\nStateChangeTimestamp=@1791374400\n\n" +
			"LoadState=not-found\nActiveState=inactive\nSubState=dead\nStateChangeTimestamp=\nId=exponetdb-node.service\n\n" +
			"Id=exponetdb-node-helper.service\nLoadState=loaded\nActiveState=failed\nSubState=failed\x1b[31m\nStateChangeTimestamp=@1791374460\n")}
	r := e.mustCall(OpServiceStatus, e.job("service.status", canon.Object{}))
	c := e.runner.calls[0]
	if strings.Join(c.Args, " ") != "show --timestamp=unix --property=Id,LoadState,ActiveState,SubState,StateChangeTimestamp -- "+
		"postgresql@17-main.service exponetdb-node.service exponetdb-node-helper.service" {
		t.Fatalf("argv %v", c.Args)
	}
	got, _ := canon.Canonicalize(r)
	// A unit that is not loaded says so; since is the last state change,
	// for a failed unit too.
	want := `{"units":[{"activeState":"active","kind":"postgresql","since":"2026-10-07T12:00:00Z","subState":"running","unit":"postgresql@17-main.service"},` +
		`{"activeState":"not-found","kind":"agent","since":null,"subState":"unloaded","unit":"exponetdb-node.service"},` +
		`{"activeState":"failed","kind":"helper","since":"2026-10-07T12:01:00Z","subState":"failed","unit":"exponetdb-node-helper.service"}]}`
	if string(got) != want {
		t.Fatalf("result %s", got)
	}
	if err := e.h.Schema.ValidateResult("service.status@1", r); err != nil {
		t.Fatal(err)
	}
	// A unit systemctl did not report is an error, never an omission.
	e.runner.out[Systemctl] = Output{Stdout: []byte("Id=postgresql@17-main.service\nActiveState=active\n")}
	e.mustRefuse(OpServiceStatus, e.job("service.status", canon.Object{}), CodeFailed)
}

func TestTrustUpdate(t *testing.T) {
	e := newEnv(t)
	newPub := nodecrypto.B64U(ed25519.NewKeyFromSeed(bytes.Repeat([]byte{4}, 32)).Public().(ed25519.PublicKey))
	add := canon.Object{
		{Name: "gateway", Value: canon.Null{}},
		{Name: "addJobKeys", Value: canon.Array{canon.Object{
			{Name: "keyId", Value: canon.String("jobkey_2027_01")}, {Name: "publicKey", Value: canon.String(newPub)},
		}}},
		{Name: "retireJobKeys", Value: canon.Array{}},
	}
	r := e.mustCall(OpTrustUpdate, e.job("config.update", add))
	got, _ := canon.Canonicalize(r)
	if string(got) != `{"jobKeys":["jobkey_2026_10","jobkey_2027_01"]}` {
		t.Fatalf("result %s", got)
	}
	// The same addition again is refused: the key is already trusted.
	e.mustRefuse(OpTrustUpdate, e.job("config.update", add), CodePreconditionFailed)
	retireUnknown := canon.Object{
		{Name: "gateway", Value: canon.Null{}},
		{Name: "addJobKeys", Value: canon.Array{}},
		{Name: "retireJobKeys", Value: canon.Array{canon.String("jobkey_unknown")}},
	}
	e.mustRefuse(OpTrustUpdate, e.job("config.update", retireUnknown), CodePreconditionFailed)
	trust, err := LoadTrust(e.h.TrustPath, os.Geteuid())
	if err != nil || len(trust.JobKeys) != 2 {
		t.Fatalf("trust %v %v", trust, err)
	}
}

func TestPackages(t *testing.T) {
	e := newEnv(t)
	e.runner.out[DpkgQuery] = Output{ExitCode: 1, Stdout: []byte(
		"postgresql-17\tii \t17.5-1.pgdg24.04+1\npostgresql-common\tii \t257.pgdg24.04+1\n" +
			"postgresql-16\trc \t16.9-1\nlibc6\tii \t2.39\n")}
	e.runner.out[AptCache] = Output{Stdout: []byte(`postgresql-17:
  Installed: 17.5-1.pgdg24.04+1
  Candidate: 17.6-1.pgdg24.04+1
  Version table:
     17.6-1.pgdg24.04+1 500
        500 http://apt.postgresql.org/pub/repos/apt noble-pgdg/main amd64 Packages
        500 http://security.ubuntu.com/ubuntu noble-security/main amd64 Packages
 *** 17.5-1.pgdg24.04+1 100
        100 /var/lib/dpkg/status
postgresql-common:
  Installed: 257.pgdg24.04+1
  Candidate: 257.pgdg24.04+1
  Version table:
 *** 257.pgdg24.04+1 500
        500 http://apt.postgresql.org/pub/repos/apt noble-pgdg/main amd64 Packages
postgresql-18:
  Installed: (none)
  Candidate: (none)
  Version table:
`)}
	r := e.mustCall(OpPackagesAudit, e.job("packages.audit", canon.Object{}))
	got, _ := canon.Canonicalize(r)
	want := `{"packages":[{"candidate":"257.pgdg24.04+1","installed":"257.pgdg24.04+1","name":"postgresql-common","security":false},` +
		`{"candidate":"17.6-1.pgdg24.04+1","installed":"17.5-1.pgdg24.04+1","name":"postgresql-17","security":true}]}`
	if string(got) != want {
		t.Fatalf("audit %s", got)
	}
	if err := e.h.Schema.ValidateResult("packages.audit@1", r); err != nil {
		t.Fatal(err)
	}
	// Planning: only allowlisted packages, exact versions, simulated.
	e.mustRefuse(OpPackagesPlanUpdate, e.job("packages.plan_update", canon.Object{{Name: "packages", Value: canon.Array{
		canon.Object{{Name: "name", Value: canon.String("openssh-server")}, {Name: "version", Value: canon.String("1:9.6")}},
	}}}), CodePreconditionFailed)
	e.runner.out[AptGet] = Output{Stdout: []byte("NOTE: This is only a simulation!\n" +
		"Inst libpq5 [17.5-1.pgdg24.04+1] (17.6-1.pgdg24.04+1 apt.postgresql.org:noble-pgdg [amd64])\n" +
		"Inst postgresql-17 [17.5-1.pgdg24.04+1] (17.6-1.pgdg24.04+1 apt.postgresql.org:noble-pgdg [amd64])\n" +
		"Conf postgresql-17 (17.6-1.pgdg24.04+1 apt.postgresql.org:noble-pgdg [amd64])\n")}
	r = e.mustCall(OpPackagesPlanUpdate, e.job("packages.plan_update", canon.Object{{Name: "packages", Value: canon.Array{
		canon.Object{{Name: "name", Value: canon.String("postgresql-17")}, {Name: "version", Value: canon.String("17.6-1.pgdg24.04+1")}},
	}}}))
	var simulate *Command
	for i := range e.runner.calls {
		if e.runner.calls[i].Path == AptGet {
			simulate = &e.runner.calls[i]
		}
	}
	if simulate == nil || strings.Join(simulate.Args, " ") !=
		"-o Dir::Cache::pkgcache= -o Dir::Cache::srcpkgcache= -s -q -o Debug::NoLocking=true install --only-upgrade postgresql-17=17.6-1.pgdg24.04+1" {
		t.Fatalf("argv %v", simulate)
	}
	got, _ = canon.Canonicalize(r)
	want = `{"changes":[{"action":"upgrade","allowlisted":false,"from":"17.5-1.pgdg24.04+1","name":"libpq5","to":"17.6-1.pgdg24.04+1"},` +
		`{"action":"upgrade","allowlisted":true,"from":"17.5-1.pgdg24.04+1","name":"postgresql-17","to":"17.6-1.pgdg24.04+1"}],` +
		`"postgresqlMajorChange":false,"restartsPostgresql":true}`
	if string(got) != want {
		t.Fatalf("plan %s", got)
	}
	if err := e.h.Schema.ValidateResult("packages.plan_update@1", r); err != nil {
		t.Fatal(err)
	}
	// A downgrade is not an update.
	e.runner.out[Dpkg] = Output{ExitCode: 1}
	e.mustRefuse(OpPackagesPlanUpdate, e.job("packages.plan_update", canon.Object{{Name: "packages", Value: canon.Array{
		canon.Object{{Name: "name", Value: canon.String("postgresql-17")}, {Name: "version", Value: canon.String("17.6-1.pgdg24.04+1")}},
	}}}), CodePreconditionFailed)
	// A half-installed package is reported as such, never as installed.
	e.runner.out[DpkgQuery] = Output{Stdout: []byte("postgresql-17\tiH \t17.5-1.pgdg24.04+1\n")}
	e.mustRefuse(OpPackagesAudit, e.job("packages.audit", canon.Object{}), CodeFailed)
}

func ownerOf(info os.FileInfo) int { return int(info.Sys().(*syscall.Stat_t).Uid) }

// TestWindowAndClockRules: the helper applies the agent's window and clock
// rules itself (Phase 4 review, L7).
func TestWindowAndClockRules(t *testing.T) {
	e := newEnv(t)
	at := func(d time.Duration) canon.String { return canon.String(e.clk.T.Add(d).Format(time.RFC3339)) }
	// notBefore beyond the tolerance.
	e.mustRefuse(OpServiceRestart, e.job("postgres.restart", restartArgs(),
		set("notBefore", at(2*time.Minute)), set("expiresAt", at(10*time.Minute))), CodeJobInvalid)
	// issuedAt ahead of the clock beyond the tolerance.
	e.mustRefuse(OpServiceRestart, e.job("postgres.restart", restartArgs(),
		set("issuedAt", at(2*time.Minute))), CodeJobInvalid)
	// A window longer than 60 minutes.
	e.mustRefuse(OpServiceRestart, e.job("postgres.restart", restartArgs(),
		set("expiresAt", at(61*time.Minute))), CodeJobInvalid)
	// A clock set back behind a job that already had its effect.
	e.mustCall(OpServiceRestart, e.job("postgres.restart", restartArgs()))
	e.clk.T = e.clk.T.Add(-5 * time.Minute)
	e.mustRefuse(OpServiceRestart, e.job("postgres.restart", restartArgs()), CodeJobInvalid)
	if len(e.runner.calls) != 1 {
		t.Fatalf("calls %v", e.runner.calls)
	}
}

// TestReplayAfterRestart: the effect ledger outlives the helper process.
func TestReplayAfterRestart(t *testing.T) {
	e := newEnv(t)
	job := e.job("postgres.restart", restartArgs())
	e.mustCall(OpServiceRestart, job)
	_ = e.h.Ledger.Close()
	ledger, err := journal.OpenLedger(filepath.Join(e.root, "state"), "effects.log", e.clk.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer ledger.Close()
	e.h.Ledger = ledger
	e.mustRefuse(OpServiceRestart, job, CodeReplayed)
	if len(e.runner.calls) != 1 {
		t.Fatal("a job ran again after a restart")
	}
}

// TestDirectivesAndCommandsAreNeverWritten: a signed job cannot make the
// fragment include files or run programs (Phase 4 review, H1).
func TestDirectivesAndCommandsAreNeverWritten(t *testing.T) {
	e := newEnv(t)
	for _, name := range []string{"include_dir", "include", "archive_command", "shared_preload_libraries", "hba_file"} {
		e.mustRefuse(OpConfigWriteFragment, e.job("postgres.config.apply",
			fragmentArgs(canon.Null{}, [2]string{name, "/tmp/x"})), CodeJobInvalid)
	}
	if _, err := os.Stat(e.root + e.in.ManagedInclude); err == nil {
		t.Fatal("a fragment was written")
	}
}

// TestRequestMemberNamesAreExact: {"OP": ...} is not "op".
func TestRequestMemberNamesAreExact(t *testing.T) {
	e := newEnv(t)
	job := e.job("service.status", canon.Object{})
	resp := e.h.Handle(context.Background(), []byte(`{"v":"exponetdb.helper/v1","op":"shell","OP":"service.status","job":`+string(job)+`}`))
	if resp.Error == nil || resp.Error.Code != CodeRequestInvalid {
		t.Fatalf("%+v", resp)
	}
}

// TestQueueWaitIsBounded: a request behind a long one gives up and does
// nothing (Phase 4 review, L8).
func TestQueueWaitIsBounded(t *testing.T) {
	e := newEnv(t)
	old := QueueWait
	QueueWait = 100 * time.Millisecond
	defer func() { QueueWait = old }()
	e.h.mu.Lock()
	defer e.h.mu.Unlock()
	req, _ := json.Marshal(Request{V: Version, Op: OpServiceRestart, Job: e.job("postgres.restart", restartArgs())})
	resp := e.h.Handle(context.Background(), req)
	if resp.Error == nil || resp.Error.Code != CodeFailed || len(e.runner.calls) != 0 {
		t.Fatalf("%+v", resp)
	}
}

// TestAFIFOInPlaceOfPgControlDoesNotHoldTheHelper (Phase 4 review, M1).
func TestAFIFOInPlaceOfPgControlDoesNotHoldTheHelper(t *testing.T) {
	e := newEnv(t)
	control := e.root + e.in.DataDirectory + "/global/pg_control"
	_ = os.Remove(control)
	if err := syscall.Mkfifo(control, 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan *ErrorBody, 1)
	go func() {
		_, refusal := e.call(OpServiceRestart, e.job("postgres.restart", restartArgs()))
		done <- refusal
	}()
	select {
	case refusal := <-done:
		if refusal == nil || refusal.Code != CodeFailed {
			t.Fatalf("%+v", refusal)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a FIFO held the helper")
	}
}

func TestFailedUnitsAndJournal(t *testing.T) {
	e := newEnv(t)
	e.runner.out[Systemctl] = Output{Stdout: []byte("backup.service loaded failed failed Backup\nbad\x01unit.service x\n")}
	r := e.mustCall(OpFailedUnits, e.job("system.health", canon.Object{}))
	got, _ := canon.Canonicalize(r)
	if string(got) != `{"units":["backup.service"]}` {
		t.Fatalf("%s", got)
	}
	e.runner.out[Journalctl] = Output{Stdout: []byte(
		`{"__REALTIME_TIMESTAMP":"1791374400000000","PRIORITY":"3","MESSAGE":"job failed"}` + "\n" +
			`{"__REALTIME_TIMESTAMP":"1791374401000000","PRIORITY":"6","MESSAGE":[104,105]}` + "\n")}
	args := func(source string, cluster canon.Value) canon.Object {
		return canon.Object{{Name: "source", Value: canon.String(source)}, {Name: "cluster", Value: cluster},
			{Name: "since", Value: canon.String("2026-10-07T00:00:00Z")}, {Name: "until", Value: canon.String("2026-10-08T00:00:00Z")},
			{Name: "minSeverity", Value: canon.String("info")}, {Name: "maxLines", Value: canon.Number(10)}}
	}
	r = e.mustCall(OpLogRead, e.job("log.inspect", args("agent", canon.Null{})))
	got, _ = canon.Canonicalize(r)
	if string(got) != `{"lines":[{"at":"2026-10-07T12:00:00Z","severity":"error","text":"job failed"},{"at":"2026-10-07T12:00:01Z","severity":"info","text":"[binary message]"}]}` {
		t.Fatalf("%s", got)
	}
	last := e.runner.calls[len(e.runner.calls)-1]
	if last.Path != Journalctl || last.Args[0] != "--unit="+AgentUnit {
		t.Fatalf("%v", last)
	}
	// PostgreSQL's log is the agent's to read, not the helper's.
	e.mustRefuse(OpLogRead, e.job("log.inspect", args("postgresql", cluster())), CodeOperationMismatch)
}

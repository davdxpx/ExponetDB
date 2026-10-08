package helper

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsafe"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
)

// The crash tests run this test binary again as a helper process that is
// killed at one step of an installation (TestMain).
const (
	crashRootEnv = "EXDB_HELPER_TEST_CRASH_ROOT"
	crashAtEnv   = "EXDB_HELPER_TEST_CRASH_AT"
)

func TestMain(m *testing.M) {
	if root := os.Getenv(crashRootEnv); root != "" {
		os.Exit(crashChild(root))
	}
	os.Exit(m.Run())
}

// crashChild is a helper process over the files of root: it serves the
// installation job in root/job.json and is killed (SIGKILL, no deferred
// function, no cleanup) at the n-th write step.
func crashChild(root string) int {
	at, err := strconv.Atoi(os.Getenv(crashAtEnv))
	if err != nil {
		fmt.Fprintln(os.Stderr, "crash child:", err)
		return 2
	}
	job, err := os.ReadFile(filepath.Join(root, "job.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "crash child:", err)
		return 2
	}
	clk := &clock.Fixed{T: time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC), Synced: true}
	h, err := openHelper(root, clk, &fakeRunner{out: map[string]Output{}})
	if err != nil {
		fmt.Fprintln(os.Stderr, "crash child:", err)
		return 2
	}
	n := 0
	fsafe.FaultHook = func(fsafe.Step, string, string) error {
		if n == at {
			_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
			for {
				time.Sleep(time.Second)
			}
		}
		n++
		return nil
	}
	req, _ := json.Marshal(Request{V: Version, Op: OpTLSInstall, Job: job})
	resp := h.Handle(context.Background(), req)
	fmt.Printf("not killed after %d steps: %+v\n", n, resp.Error)
	return 0
}

// pairShape: which files of the pair exist before the rotation.
type pairShape struct {
	name      string
	key, cert bool
	// stale: copies of an older change lie next to missing files.
	stale bool
}

var pairShapes = []pairShape{
	{name: "previous pair", key: true, cert: true},
	{name: "no previous pair", key: false, cert: false},
	{name: "no previous pair, stale copies", stale: true},
	{name: "previous key only", key: true},
}

type pairFixture struct {
	e                 *env
	shape             pairShape
	oldKey, oldCert   []byte // nil: absent
	newKey, newCert   []byte
	job               []byte
	jobID             string
	keyPath, certPath string
}

func pemOf(typ string, der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der})
}

func writeOwned(t *testing.T, path string, data []byte, mode os.FileMode, uid int) {
	t.Helper()
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	// As root the files belong to the data directory's owner (newEnv); as
	// another user they stay that user's, like the data directory.
	if os.Geteuid() == 0 {
		if err := os.Chown(path, uid, uid); err != nil {
			t.Fatal(err)
		}
	}
}

// newPairFixture: a cluster whose pair has the shape, a staged key and a
// signed rotation job for it.
func newPairFixture(t *testing.T, shape pairShape) *pairFixture {
	t.Helper()
	e := newEnv(t)
	f := &pairFixture{e: e, shape: shape, keyPath: e.root + e.in.TLSKeyFile, certPath: e.root + e.in.TLSCertificateFile}
	ca := newCA(t, e.clk.T)
	expected := canon.Value(canon.Null{})
	if shape.key {
		k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		der, _ := x509.MarshalPKCS8PrivateKey(k)
		f.oldKey = pemOf("PRIVATE KEY", der)
		writeOwned(t, f.keyPath, f.oldKey, 0o600, e.dataUID)
		if shape.cert {
			leaf := ca.issue(t, &k.PublicKey, e.clk.T)
			f.oldCert = pemOf("CERTIFICATE", leaf)
			// Another mode than the one an installation writes: a restore
			// puts back the previous mode, not the new one.
			writeOwned(t, f.certPath, f.oldCert, 0o640, e.dataUID)
			expected = canon.String(fingerprint(leaf))
		}
	}
	if shape.stale {
		writeOwned(t, f.keyPath+fsafe.PreviousSuffix, []byte("stale key\n"), 0o600, e.dataUID)
		writeOwned(t, f.certPath+fsafe.PreviousSuffix, []byte("stale certificate\n"), 0o644, e.dataUID)
	}
	plan := e.mustCall(OpTLSGenerateKey, e.job("postgres.tls.plan", tlsPlanArgs()))
	id, pubText := str(plan, "stagingId"), str(plan, "publicKey")
	staged, err := os.ReadFile(e.h.StagingDirectory + "/" + id + stagedKeySuffix)
	if err != nil {
		t.Fatal(err)
	}
	f.newKey = staged
	point, _ := nodecrypto.FromB64UOf(pubText, 65)
	pub, _ := nodecrypto.ParseP256PublicKey(point)
	leaf := ca.issue(t, pub, e.clk.T)
	f.newCert = append(pemOf("CERTIFICATE", leaf), pemOf("CERTIFICATE", ca.cert.Raw)...)
	f.job = e.job("postgres.tls.rotate", rotateArgs(id, pubText, [][]byte{leaf, ca.cert.Raw}, expected))
	v, _ := canon.Parse(f.job)
	f.jobID = str(v.(canon.Object), "jobId")
	return f
}

func fileState(path string) ([]byte, os.FileInfo, bool) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, nil, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, false
	}
	return data, info, true
}

// pair reads the pair: "old" (exactly the previous files, absent ones
// absent, with their owner and mode), "new" (both installed, key 0600 and
// certificate 0644 of the data directory's owner), anything else is mixed.
func (f *pairFixture) pair() string {
	key, keyInfo, keyThere := fileState(f.keyPath)
	cert, certInfo, certThere := fileState(f.certPath)
	if keyThere && certThere && bytes.Equal(key, f.newKey) && bytes.Equal(cert, f.newCert) {
		if keyInfo.Mode().Perm() != 0o600 || certInfo.Mode().Perm() != 0o644 ||
			ownerOf(keyInfo) != f.e.dataUID || ownerOf(certInfo) != f.e.dataUID {
			return fmt.Sprintf("new with key %v uid %d, certificate %v uid %d", keyInfo.Mode(), ownerOf(keyInfo), certInfo.Mode(), ownerOf(certInfo))
		}
		return "new"
	}
	oldKey := (f.oldKey == nil && !keyThere) || (f.oldKey != nil && keyThere && bytes.Equal(key, f.oldKey))
	oldCert := (f.oldCert == nil && !certThere) || (f.oldCert != nil && certThere && bytes.Equal(cert, f.oldCert))
	if oldKey && oldCert {
		if keyThere && (keyInfo.Mode().Perm() != 0o600 || ownerOf(keyInfo) != f.e.dataUID) ||
			certThere && (certInfo.Mode().Perm() != 0o640 || ownerOf(certInfo) != f.e.dataUID) {
			return "old with another owner or mode"
		}
		return "old"
	}
	describe := func(there bool, data, oldData, newData []byte) string {
		switch {
		case !there:
			return "absent"
		case bytes.Equal(data, newData):
			return "new"
		case oldData != nil && bytes.Equal(data, oldData):
			return "old"
		}
		return "other"
	}
	return fmt.Sprintf("mixed: key %s, certificate %s", describe(keyThere, key, f.oldKey, f.newKey),
		describe(certThere, cert, f.oldCert, f.newCert))
}

func (f *pairFixture) recordPath() string {
	return filepath.Join(f.e.root, "state", "tls-install.json")
}

// recordState is the state of the installation record ("" without one).
func (f *pairFixture) recordState(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(f.recordPath())
	if os.IsNotExist(err) {
		return ""
	}
	var r struct {
		State string `json:"state"`
	}
	if err != nil || json.Unmarshal(data, &r) != nil {
		return "unreadable"
	}
	return r.State
}

// leftovers lists temporary files of the pair or the record (a crash
// between a temporary file and its rename leaves one).
func (f *pairFixture) leftovers() []string {
	var out []string
	for _, dir := range []string{filepath.Dir(f.keyPath), filepath.Join(f.e.root, "state")} {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".") && strings.Contains(e.Name(), ".exponetdb-") {
				out = append(out, e.Name())
			}
		}
	}
	return out
}

func ledgerLines(t *testing.T, root string) int {
	t.Helper()
	f, err := os.Open(filepath.Join(root, "state", "effects.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	n := 0
	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 1<<20), 1<<20)
	for s.Scan() {
		n++
	}
	return n
}

type writeStep struct {
	step fsafe.Step
	name string
}

func (s writeStep) String() string { return string(s.step) + " " + s.name }

// installSteps runs one installation of the shape and returns its write
// steps in order.
func installSteps(t *testing.T, shape pairShape) []writeStep {
	t.Helper()
	f := newPairFixture(t, shape)
	var steps []writeStep
	fsafe.FaultHook = func(s fsafe.Step, _, name string) error {
		steps = append(steps, writeStep{s, name})
		return nil
	}
	_, refusal := f.e.call(OpTLSInstall, f.job)
	fsafe.FaultHook = nil
	if refusal != nil || f.pair() != "new" {
		t.Fatalf("the installation without a fault: %+v, pair %s", refusal, f.pair())
	}
	t.Logf("%d write steps: %v", len(steps), steps)
	return steps
}

// certificateInPlace is the first step at which the new certificate has
// replaced the previous one: from there the new pair is complete.
func certificateInPlace(t *testing.T, steps []writeStep) int {
	t.Helper()
	for i, s := range steps {
		if s.step == fsafe.AfterRename && s.name == "server.crt" {
			return i
		}
	}
	t.Fatalf("no rename of the certificate in %v", steps)
	return 0
}

var errInjected = errors.New("injected fault")

// noKeyMaterial: what the helper says or keeps carries no private key.
func noKeyMaterial(t *testing.T, where string, text []byte, keys ...[]byte) {
	t.Helper()
	if bytes.Contains(text, []byte("PRIVATE KEY")) {
		t.Errorf("%s holds a PEM private key", where)
	}
	for _, k := range keys {
		if k == nil {
			continue
		}
		block, _ := pem.Decode(k)
		body := strings.Join(strings.Split(strings.TrimSpace(string(k)), "\n")[1:3], "")
		if block != nil && (bytes.Contains(text, block.Bytes) || strings.Contains(string(text), body)) {
			t.Errorf("%s holds key material", where)
		}
	}
}

// TestTLSPairFaultAtEveryStep: an error at any write step of a rotation,
// before or after the step happened (a rename done and its directory sync
// failed included), leaves the complete previous pair (the job reported
// failed) or the complete new one (reported installed), never a mixed pair;
// a restarted helper finds nothing unsettled, and the job stays spent. Once
// both files hold the new pair, an error writes them again, fresh, before
// the record says committed: a sync that failed after a rename may have
// lost the new file, and a second sync proves nothing (correction review
// of F6); before that, the previous pair is put back.
func TestTLSPairFaultAtEveryStep(t *testing.T) {
	for _, shape := range pairShapes {
		t.Run(shape.name, func(t *testing.T) {
			steps := installSteps(t, shape)
			complete := certificateInPlace(t, steps)
			for i, s := range steps {
				f := newPairFixture(t, shape)
				n := 0
				fsafe.FaultHook = func(fsafe.Step, string, string) error {
					n++
					if n-1 == i {
						return errInjected
					}
					return nil
				}
				result, refusal := f.e.call(OpTLSInstall, f.job)
				fsafe.FaultHook = nil
				want := "old"
				if i >= complete {
					want = "new"
				}
				if got := f.pair(); got != want {
					t.Errorf("fault at %d (%s): pair %s, want %s (refusal %+v)", i, s, got, want, refusal)
					continue
				}
				switch {
				case want == "new" && refusal != nil:
					t.Errorf("fault at %d (%s): the new pair is installed but the job was refused: %+v", i, s, refusal)
				case want == "new" && str(result, "fingerprint") == "":
					t.Errorf("fault at %d (%s): result %v", i, s, result)
				case want == "old" && (refusal == nil || refusal.Code != CodeFailed):
					t.Errorf("fault at %d (%s): the previous pair is in place but the job reads %+v %v", i, s, refusal, result)
				}
				if refusal != nil {
					noKeyMaterial(t, "the refusal", []byte(refusal.Message), f.oldKey, f.newKey)
				}
				if st := f.recordState(t); st == "prepared" || st == "unreadable" {
					t.Errorf("fault at %d (%s): the record is %s", i, s, st)
				}
				// A restarted helper has nothing to settle; the pair stays.
				f.e.restart()
				if _, err := f.e.h.SettleTLSInstall(); err != nil {
					t.Errorf("fault at %d (%s): settle after restart: %v", i, s, err)
				}
				if got := f.pair(); got != want {
					t.Errorf("fault at %d (%s): after restart the pair is %s, want %s", i, s, got, want)
				}
				f.e.mustRefuse(OpTLSInstall, f.job, CodeReplayed)
				if ops := f.e.h.Ledger.Ops(f.jobID); len(ops) != 1 || ops[0] != OpTLSInstall {
					t.Errorf("fault at %d (%s): ledger %v", i, s, ops)
				}
			}
		})
	}
}

// TestTLSPairSecondFaultNeverLeavesAMixedPair: the certificate's write fails
// after its rename (both files hold the new pair), then a second write fails
// while the helper settles that, at every step it takes (correction review,
// round 2). The files are never a mixed pair, and a restarted helper
// settles them to one pair.
func TestTLSPairSecondFaultNeverLeavesAMixedPair(t *testing.T) {
	for _, shape := range pairShapes {
		t.Run(shape.name, func(t *testing.T) {
			steps := installSteps(t, shape)
			first := certificateInPlace(t, steps)
			for second := first + 1; ; second++ {
				f := newPairFixture(t, shape)
				n := 0
				fsafe.FaultHook = func(fsafe.Step, string, string) error {
					n++
					if n-1 == first || n-1 == second {
						return errInjected
					}
					return nil
				}
				_, refusal := f.e.call(OpTLSInstall, f.job)
				fsafe.FaultHook = nil
				if n-1 < second {
					break // every step of the settling had its fault
				}
				if got := f.pair(); got != "old" && got != "new" {
					t.Errorf("faults at %d and %d: pair %s (refusal %+v)", first, second, got, refusal)
				}
				f.e.restart()
				if _, err := f.e.h.SettleTLSInstall(); err != nil {
					t.Errorf("faults at %d and %d: settle after restart: %v", first, second, err)
				}
				if got := f.pair(); got != "old" && got != "new" {
					t.Errorf("faults at %d and %d: after restart the pair is %s", first, second, got)
				}
				if st := f.recordState(t); st == "prepared" || st == "unreadable" {
					t.Errorf("faults at %d and %d: the record is %s after a restart", first, second, st)
				}
			}
		})
	}
}

// TestTLSPairCrashAtEveryStep: a helper process killed at any write step of
// a rotation and started again leaves the complete previous pair or the
// complete new one, the previously missing files included; the recovery
// needs no job, admits nothing and keeps the ledger as it was, so the job
// stays spent, even once it has expired.
func TestTLSPairCrashAtEveryStep(t *testing.T) {
	for _, shape := range pairShapes {
		t.Run(shape.name, func(t *testing.T) {
			steps := installSteps(t, shape)
			complete := certificateInPlace(t, steps)
			for i, s := range steps {
				f := newPairFixture(t, shape)
				_ = f.e.h.Ledger.Close() // the helper that planned stops
				if err := os.WriteFile(filepath.Join(f.e.root, "job.json"), f.job, 0o600); err != nil {
					t.Fatal(err)
				}
				cmd := exec.Command(os.Args[0], "-test.run=^$")
				cmd.Env = append(os.Environ(), crashRootEnv+"="+f.e.root, crashAtEnv+"="+strconv.Itoa(i))
				out, err := cmd.CombinedOutput()
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
					t.Fatalf("crash at %d (%s): the helper process was not killed: %v %s", i, s, err, out)
				}
				if data, err := os.ReadFile(f.recordPath()); err == nil {
					noKeyMaterial(t, "the installation record", data, f.oldKey, f.newKey)
				}
				// Odd steps also let the job expire before the helper starts
				// again: the recovery needs no job.
				if i%2 == 1 {
					f.e.clk.T = f.e.clk.T.Add(2 * time.Hour)
				}
				h, err := openHelper(f.e.root, f.e.clk, f.e.runner)
				if err != nil {
					t.Fatal(err)
				}
				f.e.h = h
				lines := ledgerLines(t, f.e.root)
				if _, err := h.SettleTLSInstall(); err != nil {
					t.Errorf("crash at %d (%s): recovery: %v", i, s, err)
				}
				want := "old"
				if i >= complete {
					want = "new"
				}
				if got := f.pair(); got != want {
					t.Errorf("crash at %d (%s): pair %s, want %s", i, s, got, want)
				}
				if st := f.recordState(t); st != "" {
					t.Errorf("crash at %d (%s): the record is still there (%s)", i, s, st)
				}
				if left := f.leftovers(); len(left) != 0 {
					t.Errorf("crash at %d (%s): temporary files left: %v", i, s, left)
				}
				if got := ledgerLines(t, f.e.root); got != lines {
					t.Errorf("crash at %d (%s): the recovery changed the ledger (%d lines, then %d)", i, s, lines, got)
				}
				if ops := h.Ledger.Ops(f.jobID); len(ops) != 1 || ops[0] != OpTLSInstall {
					t.Errorf("crash at %d (%s): ledger %v", i, s, ops)
				}
				code := CodeReplayed
				if i%2 == 1 {
					code = CodeJobInvalid // expired: it authorizes nothing new
				}
				f.e.mustRefuse(OpTLSInstall, f.job, code)
				if got := f.pair(); got != want {
					t.Errorf("crash at %d (%s): the refused job changed the pair: %s", i, s, got)
				}
			}
		})
	}
}

// TestTLSPairUnsettledInstallationBlocksEveryChange: when even the recovery
// cannot run (the disk keeps failing), the job reads outcome unknown, the
// record stays unfinished and every other change is refused before its
// effect (its job is not spent) while reads are served; once the disk
// recovers, the next change settles the pair first, and only then runs.
func TestTLSPairUnsettledInstallationBlocksEveryChange(t *testing.T) {
	for _, c := range []struct {
		from string
		want string
	}{
		{"server.key", "old"}, // new key, previous certificate: restored
		{"server.crt", "new"}, // both new, never synced: committed
	} {
		t.Run("failing from the rename of "+c.from, func(t *testing.T) {
			f := newPairFixture(t, pairShapes[0])
			failing := false
			fsafe.FaultHook = func(s fsafe.Step, _, name string) error {
				failing = failing || (s == fsafe.AfterRename && name == c.from)
				if failing {
					return errInjected
				}
				return nil
			}
			defer func() { fsafe.FaultHook = nil }()
			_, refusal := f.e.call(OpTLSInstall, f.job)
			if refusal == nil || refusal.Code != CodeOutcomeUnknown {
				t.Fatalf("refusal %+v", refusal)
			}
			if st := f.recordState(t); st != "prepared" {
				t.Fatalf("record %q", st)
			}
			fragment := hostPath(f.e, f.e.in.ManagedInclude)
			change := f.e.job("postgres.config.apply", fragmentArgs(canon.Null{}, [2]string{"work_mem", "64MB"}))
			v, _ := canon.Parse(change)
			changeID := str(v.(canon.Object), "jobId")
			_, refusal = f.e.call(OpConfigPatchFragment, change)
			if refusal == nil || refusal.Code != CodeFailed || !strings.Contains(refusal.Message, "TLS installation") {
				t.Fatalf("another change while the pair is unsettled: %+v", refusal)
			}
			if ops := f.e.h.Ledger.Ops(changeID); len(ops) != 0 {
				t.Fatalf("the refused change spent its job: %v", ops)
			}
			if _, err := os.Stat(fragment); err == nil {
				t.Fatal("the refused change wrote its file")
			}
			// Reads are served.
			f.e.mustCall(OpTrustInspect, f.e.job("agent.diagnostics", canon.Object{}))
			// After a restart, still unsettled: the startup says so.
			f.e.restart()
			if _, err := f.e.h.SettleTLSInstall(); err == nil {
				t.Fatal("the startup settled an installation it cannot write")
			}
			// The disk recovers.
			fsafe.FaultHook = nil
			f.e.mustCall(OpConfigPatchFragment, change)
			if got := f.pair(); got != c.want {
				t.Fatalf("pair %s, want %s", got, c.want)
			}
			if st := f.recordState(t); st != "" {
				t.Fatalf("record %q", st)
			}
			f.e.mustRefuse(OpTLSInstall, f.job, CodeReplayed)
			if ops := f.e.h.Ledger.Ops(f.jobID); len(ops) != 1 {
				t.Fatalf("ledger %v", ops)
			}
		})
	}
}

func hostPath(e *env, p string) string { return e.root + p }

// pairRecordJSON writes an installation record as the helper does: the
// canonical JSON of its members, checksum over the record without it.
func pairRecordJSON(t *testing.T, members map[string]any) []byte {
	t.Helper()
	body, err := json.Marshal(members)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := canon.Transform(body)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(canonical)
	members["checksum"] = "sha256:" + hex.EncodeToString(sum[:])
	body, _ = json.Marshal(members)
	out, err := canon.Transform(body)
	if err != nil {
		t.Fatal(err)
	}
	return append(out, '\n')
}

func digestOf(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// preparedRecord is the record of an installation of the fixture that
// stopped before it touched the pair.
func (f *pairFixture) preparedRecord(t *testing.T, keyPath, certPath string) map[string]any {
	t.Helper()
	info, err := os.Stat(f.e.root + f.e.in.DataDirectory)
	if err != nil {
		t.Fatal(err)
	}
	// The fixture's files and the installed ones belong to the data
	// directory's owner and group.
	gid := int(info.Sys().(*syscall.Stat_t).Gid)
	version := func(data []byte, mode string) map[string]any {
		return map[string]any{"digest": digestOf(data), "uid": f.e.dataUID, "gid": gid, "mode": mode}
	}
	file := func(path string, old, next []byte, oldMode, newMode string) map[string]any {
		m := map[string]any{"path": path, "existed": old != nil, "previous": nil, "new": version(next, newMode)}
		if old != nil {
			m["previous"] = version(old, oldMode)
		}
		return m
	}
	return map[string]any{
		"schema": "exponetdb.helper-tls-install/v1", "state": "prepared", "jobId": f.jobID, "cluster": "17/main",
		"key":         file(keyPath, f.oldKey, f.newKey, "0600", "0600"),
		"certificate": file(certPath, f.oldCert, f.newCert, "0640", "0644"),
	}
}

// TestTLSPairRecordThatCannotBeTrustedStopsEveryChange: a record that does
// not read back exactly as the helper wrote it, that someone else could have
// written, or that names files the operator no longer maps is never guessed
// at: the startup says so, every change is refused with a clear message and
// nothing is touched, while reads are served.
func TestTLSPairRecordThatCannotBeTrustedStopsEveryChange(t *testing.T) {
	for _, c := range []struct {
		name  string
		write func(f *pairFixture) ([]byte, os.FileMode)
	}{
		{"not JSON", func(*pairFixture) ([]byte, os.FileMode) { return []byte("{\"schema\":"), 0o600 }},
		{"checksum", func(f *pairFixture) ([]byte, os.FileMode) {
			data := pairRecordJSON(t, f.preparedRecord(t, f.e.in.TLSKeyFile, f.e.in.TLSCertificateFile))
			return bytes.Replace(data, []byte(`"state":"prepared"`), []byte(`"state":"restored"`), 1), 0o600
		}},
		{"unknown member", func(f *pairFixture) ([]byte, os.FileMode) {
			r := f.preparedRecord(t, f.e.in.TLSKeyFile, f.e.in.TLSCertificateFile)
			r["command"] = "rm -rf /"
			return pairRecordJSON(t, r), 0o600
		}},
		{"not canonical", func(f *pairFixture) ([]byte, os.FileMode) {
			data := pairRecordJSON(t, f.preparedRecord(t, f.e.in.TLSKeyFile, f.e.in.TLSCertificateFile))
			return append([]byte(" "), data...), 0o600
		}},
		{"writable by others", func(f *pairFixture) ([]byte, os.FileMode) {
			return pairRecordJSON(t, f.preparedRecord(t, f.e.in.TLSKeyFile, f.e.in.TLSCertificateFile)), 0o666
		}},
		{"files the operator does not map", func(f *pairFixture) ([]byte, os.FileMode) {
			return pairRecordJSON(t, f.preparedRecord(t, "/etc/shadow", f.e.in.TLSCertificateFile)), 0o600
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newPairFixture(t, pairShapes[0])
			data, mode := c.write(f)
			if err := os.WriteFile(f.recordPath(), data, mode); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(f.recordPath(), mode); err != nil {
				t.Fatal(err)
			}
			f.e.restart()
			lines := ledgerLines(t, f.e.root)
			if _, err := f.e.h.SettleTLSInstall(); err == nil || !strings.Contains(err.Error(), "tls-install.json") {
				t.Fatalf("startup: %v", err)
			}
			for _, call := range []struct {
				op  string
				job []byte
			}{
				{OpTLSInstall, f.job},
				{OpServiceRestart, f.e.job("postgres.restart", restartArgs())},
				{OpConfigPatchFragment, f.e.job("postgres.config.apply", fragmentArgs(canon.Null{}, [2]string{"work_mem", "64MB"}))},
				{OpTLSGenerateKey, f.e.job("postgres.tls.plan", tlsPlanArgs())},
			} {
				_, refusal := f.e.call(call.op, call.job)
				if refusal == nil || refusal.Code != CodeFailed || !strings.Contains(refusal.Message, "TLS installation") {
					t.Fatalf("%s: %+v", call.op, refusal)
				}
			}
			if got := ledgerLines(t, f.e.root); got != lines {
				t.Fatal("a refused change was admitted")
			}
			if len(f.e.runner.calls) != 0 {
				t.Fatalf("a refused change ran %v", f.e.runner.calls)
			}
			if got := f.pair(); got != "old" {
				t.Fatalf("pair %s", got)
			}
			if _, err := os.Stat(hostPath(f.e, f.e.in.ManagedInclude)); err == nil {
				t.Fatal("a refused change wrote its file")
			}
			after, _ := os.ReadFile(f.recordPath())
			if !bytes.Equal(after, data) {
				t.Fatal("the record was changed")
			}
			f.e.mustCall(OpTrustInspect, f.e.job("agent.diagnostics", canon.Object{}))
			// The operator resolves it (node runbook): the record moved aside.
			if err := os.Rename(f.recordPath(), f.recordPath()+".inspected"); err != nil {
				t.Fatal(err)
			}
			f.e.mustCall(OpTLSInstall, f.job)
			if got := f.pair(); got != "new" {
				t.Fatalf("pair %s", got)
			}
		})
	}
}

// TestTLSPairInterruptedInstallationIsSettledBeforeTheNextChange: a prepared
// record from a helper that stopped is settled from the record alone before
// the next change, even when the change is another rotation; the record's
// job is not admitted again.
func TestTLSPairInterruptedInstallationIsSettledBeforeTheNextChange(t *testing.T) {
	f := newPairFixture(t, pairShapes[0])
	// The new key in place, the certificate not yet: what a helper killed
	// between the two renames leaves.
	writeOwned(t, f.keyPath+fsafe.PreviousSuffix, f.oldKey, 0o600, f.e.dataUID)
	writeOwned(t, f.certPath+fsafe.PreviousSuffix, f.oldCert, 0o640, f.e.dataUID)
	writeOwned(t, f.keyPath, f.newKey, 0o600, f.e.dataUID)
	if err := os.WriteFile(f.recordPath(), pairRecordJSON(t, f.preparedRecord(t, f.e.in.TLSKeyFile, f.e.in.TLSCertificateFile)), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := f.pair(); !strings.HasPrefix(got, "mixed") {
		t.Fatalf("setup: %s", got)
	}
	f.e.mustCall(OpConfigPatchFragment, f.e.job("postgres.config.apply", fragmentArgs(canon.Null{}, [2]string{"work_mem", "64MB"})))
	if got := f.pair(); got != "old" {
		t.Fatalf("pair %s", got)
	}
	if st := f.recordState(t); st != "" {
		t.Fatalf("record %q", st)
	}
	if ops := f.e.h.Ledger.Ops(f.jobID); len(ops) != 0 {
		t.Fatalf("the recovery admitted the record's job: %v", ops)
	}
}

// TestTLSPairStateDirectory: the record lives in the state directory, or in
// the staging directory's parent when none is set (as the helper process
// lays them out); that directory may be readable but never writable by
// anyone but root, or every change stops.
func TestTLSPairStateDirectory(t *testing.T) {
	f := newPairFixture(t, pairShapes[0])
	state := filepath.Join(f.e.root, "state")
	f.e.h.StateDirectory = ""
	if err := os.Chmod(state, 0o755); err != nil {
		t.Fatal(err)
	}
	written := false
	fsafe.FaultHook = func(s fsafe.Step, dir, name string) error {
		written = written || (s == fsafe.AfterRename && dir == state && name == pairRecordName)
		return nil
	}
	f.e.mustCall(OpTLSInstall, f.job)
	fsafe.FaultHook = nil
	if !written || f.pair() != "new" {
		t.Fatalf("record written %v, pair %s", written, f.pair())
	}
	if err := os.Chmod(state, 0o775); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(state, 0o700)
	if _, err := f.e.h.SettleTLSInstall(); err == nil || !strings.Contains(err.Error(), "root's alone to write") {
		t.Fatalf("settle with a group-writable state directory: %v", err)
	}
	if _, blocked := f.e.h.settlePair(); blocked == nil || blocked.refusal().Code != CodeFailed {
		t.Fatalf("a change with a group-writable state directory: %+v", blocked)
	}
}

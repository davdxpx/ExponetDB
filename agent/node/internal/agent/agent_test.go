package agent

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/enroll"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
	"github.com/davdxpx/ExponetDB/agent/node/internal/testgateway"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

type fakeHost struct{}

func (fakeHost) Facts() (protocol.HostFacts, error) {
	return protocol.HostFacts{Hostname: "db-host-01", Os: "ubuntu 24.04", Kernel: "6.8.0", Cpus: 8,
		MemoryBytes: 1 << 34, MachineIDHash: "sha256:" + strings.Repeat("3", 64)}, nil
}

func (fakeHost) Metrics([]string) (protocol.HeartbeatRequestHost, error) {
	return protocol.HeartbeatRequestHost{Mounts: []protocol.HeartbeatRequestHostMount{}}, nil
}

type env struct {
	t     *testing.T
	gw    *testgateway.Gateway
	store *state.Store
	cfg   *config.Config
	clk   *clock.Fixed
	v     *schema.Validator
	// runLimit overrides every capability's run limit when set.
	runLimit time.Duration
}

// enrolled enrolls a fresh node against a fake gateway and returns its store.
func enrolled(t *testing.T) *env {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	gw := testgateway.New(t, now)
	v, err := schema.Protocol()
	if err != nil {
		t.Fatal(err)
	}
	res, err := enroll.Enroll(context.Background(), gw.Token(now.Add(30*time.Minute)), enroll.Options{
		AgentVersion: "1.0.0", Host: mustFacts(t), Schema: v, Now: func() time.Time { return now }, Dial: gw.URL(),
	})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := state.Open(dir, os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveIdentity(res.Identity); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveState(res.State); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Schema: config.Schema, StateDirectory: dir, HelperSocket: "/run/exponetdb-node/helper.sock",
		DisabledCapabilities: []string{}, Instances: []config.Instance{}}
	return &env{t: t, gw: gw, store: store, cfg: cfg, clk: &clock.Fixed{T: now.Add(time.Second), Synced: true}, v: v}
}

func mustFacts(t *testing.T) protocol.HostFacts {
	f, _ := fakeHost{}.Facts()
	return f
}

// start runs an agent until the test ends.
func (e *env) start(caps ...Capability) *Agent {
	e.t.Helper()
	a, err := New(Options{
		Config: e.cfg, Store: e.store, Version: "1.0.0", Clock: e.clk, Host: fakeHost{}, Schema: e.v,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Capabilities: caps,
		ClaimWait: 1, HeartbeatInterval: 50 * time.Millisecond, ProgressInterval: 20 * time.Millisecond,
		StartDeadline: 300 * time.Millisecond, Dial: e.gw.URL(), RunLimit: e.runLimit,
	})
	if err != nil {
		e.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = a.Run(ctx) }()
	e.t.Cleanup(func() { cancel(); <-done })
	return a
}

func noArgs() canon.Object { return canon.Object{} }

func (e *env) job(id, nonce, name string, args canon.Object) canon.Object {
	return e.gw.Job(e.t, e.gw.Key, id, nonce, name, args, e.clk.T)
}

const (
	job1 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y01"
	job2 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y02"
	job3 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y03"
	job4 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y04"
	job5 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y05"
)

func nonce(i byte) string {
	return nodecrypto.B64U([]byte{i, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15})
}

func TestJobRunsOnceAndIsSigned(t *testing.T) {
	e := enrolled(t)
	a := e.start()
	e.gw.Enqueue(e.job(job1, nonce(1), "agent.diagnostics", noArgs()))
	c := e.gw.WaitCompletion(t, job1, 5*time.Second)
	if c.Request.Outcome != "succeeded" || !c.NR1Valid {
		t.Fatalf("completion %+v (nr1 %v)", c.Request, c.NR1Valid)
	}
	var result canon.Value
	result, _ = canon.Parse(c.Request.Result)
	if err := e.v.ValidateResult("agent.diagnostics@1", result); err != nil {
		t.Fatalf("result: %v", err)
	}
	if a.journal.State(job1) != journal.KindCompleted {
		t.Fatal("journal")
	}
	if hellos := e.gw.Hellos(); len(hellos) == 0 || len(hellos[0].Capabilities) != 2 {
		t.Fatalf("hello capabilities: %+v", hellos)
	}

	// The same envelope again is a replay; a new job id with the same nonce too.
	e.gw.Enqueue(e.job(job1, nonce(1), "agent.diagnostics", noArgs()))
	e.gw.Enqueue(e.job(job2, nonce(1), "agent.diagnostics", noArgs()))
	if c := e.gw.WaitCompletion(t, job2, 5*time.Second); c.Request.Outcome != "rejected" || *c.Request.RejectionReason != verify.NonceReplayed || !c.NR1Valid {
		t.Fatalf("nonce replay: %+v", c.Request)
	}
	if starts := e.gw.Starts(); len(starts) != 1 {
		t.Fatalf("started %v", starts)
	}
}

func TestForgedJobIsRefusedAndNotJournaled(t *testing.T) {
	e := enrolled(t)
	a := e.start()
	forged := e.gw.Job(t, testgateway.JobKey{ID: e.gw.Key.ID, Seed: []byte(strings.Repeat("x", 32))}, job1, nonce(1), "agent.diagnostics", noArgs(), e.clk.T)
	e.gw.Enqueue(forged)
	c := e.gw.WaitCompletion(t, job1, 5*time.Second)
	if c.Request.Outcome != "rejected" || *c.Request.RejectionReason != verify.SignatureInvalid {
		t.Fatalf("%+v", c.Request)
	}
	if a.journal.Known(job1) {
		t.Fatal("an unsigned job id was journaled")
	}
}

func TestUntrustedClockRefusesJobs(t *testing.T) {
	e := enrolled(t)
	e.clk.Synced = false
	e.start()
	e.gw.Enqueue(e.job(job1, nonce(1), "agent.diagnostics", noArgs()))
	if c := e.gw.WaitCompletion(t, job1, 5*time.Second); *c.Request.RejectionReason != verify.ClockUntrusted {
		t.Fatalf("%+v", c.Request)
	}
}

func TestStartNotAcknowledgedIsNeverExecuted(t *testing.T) {
	e := enrolled(t)
	a := e.start()
	e.gw.RefuseStart(job1)
	e.gw.Enqueue(e.job(job1, nonce(1), "agent.diagnostics", noArgs()))
	deadline := time.Now().Add(5 * time.Second)
	for a.journal.State(job1) != journal.KindAbandoned {
		if time.Now().After(deadline) {
			t.Fatalf("state %q", a.journal.State(job1))
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Its one statement: rejected, never started.
	if c := e.gw.WaitCompletion(t, job1, 5*time.Second); c.Request.Outcome != "rejected" ||
		*c.Request.RejectionReason != verify.StartUnacknowledged || !c.NR1Valid {
		t.Fatalf("%+v", c.Request)
	}
	// A re-delivery after the lost start is a replay: never an execution, and
	// nothing new is signed.
	received := e.gw.Received(job1)
	e.gw.Enqueue(e.job(job1, nonce(1), "agent.diagnostics", noArgs()))
	time.Sleep(500 * time.Millisecond)
	if e.gw.Received(job1) != received || len(e.gw.Starts()) != 0 || a.journal.State(job1) != journal.KindAbandoned {
		t.Fatalf("re-delivery: %d completions, starts %v", e.gw.Received(job1), e.gw.Starts())
	}
}

func TestCompletionIsBufferedUntilDelivered(t *testing.T) {
	e := enrolled(t)
	e.gw.FailCompletions(3)
	a := e.start()
	e.gw.Enqueue(e.job(job1, nonce(1), "agent.diagnostics", noArgs()))
	c := e.gw.WaitCompletion(t, job1, 10*time.Second)
	if c.Request.Outcome != "succeeded" || !c.NR1Valid {
		t.Fatalf("%+v", c.Request)
	}
	deadline := time.Now().Add(5 * time.Second)
	for a.buffer.Len() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("buffer not emptied after delivery")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestCrashedJobIsReportedNotResumed(t *testing.T) {
	e := enrolled(t)
	j, err := journal.Open(e.store.Path(state.JournalDir), func() time.Time { return e.clk.T })
	if err != nil {
		t.Fatal(err)
	}
	_ = j.Accept(journal.Accepted{JobID: job1, OperationID: testgateway.OperationID, Capability: "agent.diagnostics@1",
		ArgsHash: "sha256:" + strings.Repeat("0", 64), Nonce: nonce(1), IssuedAt: "2026-10-07T12:00:00Z", ExpiresAt: "2026-10-07T12:15:00Z"})
	_ = j.Start(job1)
	_ = j.Step(job1, 0, "collect", "succeeded")
	_ = j.Close()
	e.start()
	deadline := time.Now().Add(5 * time.Second)
	for len(e.gw.Hellos()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("no hello")
		}
		time.Sleep(10 * time.Millisecond)
	}
	in := e.gw.Hellos()[0].Journal.InFlight
	if len(in) != 1 || in[0].JobID != job1 || in[0].LastStep != 0 || in[0].State != "started" {
		t.Fatalf("in flight %+v", in)
	}
	// A re-delivery neither resumes it nor signs anything about it.
	e.gw.Enqueue(e.job(job1, nonce(2), "agent.diagnostics", noArgs()))
	time.Sleep(500 * time.Millisecond)
	if e.gw.Received(job1) != 0 || len(e.gw.Starts()) != 0 {
		t.Fatalf("crashed job answered: %d completions, starts %v", e.gw.Received(job1), e.gw.Starts())
	}
}

func TestCorruptJournalRefusesEveryJob(t *testing.T) {
	e := enrolled(t)
	path := filepath.Join(e.store.Path(state.JournalDir), "journal.log")
	if err := os.WriteFile(path, []byte("{\"not\":\"a record\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	e.start()
	e.gw.Enqueue(e.job(job1, nonce(1), "agent.diagnostics", noArgs()))
	if c := e.gw.WaitCompletion(t, job1, 5*time.Second); *c.Request.RejectionReason != verify.JournalCorrupt {
		t.Fatalf("%+v", c.Request)
	}
}

func TestConfigUpdateRotatesJobKeys(t *testing.T) {
	e := enrolled(t)
	a := e.start()
	next := testgateway.JobKey{ID: "jobkey_2027_01", Seed: []byte(strings.Repeat("n", 32))}
	add := canon.Object{
		{Name: "gateway", Value: canon.Null{}},
		{Name: "addJobKeys", Value: canon.Array{canon.Object{
			{Name: "keyId", Value: canon.String(next.ID)},
			{Name: "publicKey", Value: canon.String(nodecrypto.B64U(next.Public()))},
		}}},
		{Name: "retireJobKeys", Value: canon.Array{}},
	}
	e.gw.Enqueue(e.job(job1, nonce(1), "config.update", add))
	if c := e.gw.WaitCompletion(t, job1, 5*time.Second); c.Request.Outcome != "succeeded" {
		t.Fatalf("add: %+v %v", c.Request, c.Request.OutputExcerpt)
	}
	// Signed with the new key: accepted. Then the old key is retired by a
	// job the new key signs, and a job under the old key is refused.
	e.gw.Enqueue(e.gw.Job(t, next, job2, nonce(2), "agent.diagnostics", noArgs(), e.clk.T))
	if c := e.gw.WaitCompletion(t, job2, 5*time.Second); c.Request.Outcome != "succeeded" {
		t.Fatalf("new key: %+v", c.Request)
	}
	retire := canon.Object{
		{Name: "gateway", Value: canon.Null{}},
		{Name: "addJobKeys", Value: canon.Array{}},
		{Name: "retireJobKeys", Value: canon.Array{canon.String(e.gw.Key.ID)}},
	}
	e.gw.Enqueue(e.gw.Job(t, next, job3, nonce(3), "config.update", retire, e.clk.T))
	if c := e.gw.WaitCompletion(t, job3, 5*time.Second); c.Request.Outcome != "succeeded" {
		t.Fatalf("retire: %+v", c.Request)
	}
	e.gw.Enqueue(e.job(job4, nonce(4), "agent.diagnostics", noArgs()))
	if c := e.gw.WaitCompletion(t, job4, 5*time.Second); *c.Request.RejectionReason != verify.UnknownSigningKey {
		t.Fatalf("old key: %+v", c.Request)
	}
	// Retiring the last key is refused before anything changes.
	last := canon.Object{
		{Name: "gateway", Value: canon.Null{}},
		{Name: "addJobKeys", Value: canon.Array{}},
		{Name: "retireJobKeys", Value: canon.Array{canon.String(next.ID)}},
	}
	e.gw.Enqueue(e.gw.Job(t, next, job5, nonce(5), "config.update", last, e.clk.T))
	if c := e.gw.WaitCompletion(t, job5, 5*time.Second); *c.Request.RejectionReason != verify.PreconditionFailed {
		t.Fatalf("last key: %+v", c.Request)
	}
	st, err := e.store.LoadState()
	if err != nil || len(st.JobKeys) != 1 || st.JobKeys[0].KeyID != next.ID || a.currentState().JobKeys[0].KeyID != next.ID {
		t.Fatalf("stored keys %+v, %v", st, err)
	}
}

// slow is a stand-in capability that waits for a cancel request before its
// effect point, as a real capability checks one.
type slow struct{ effect chan struct{} }

func (slow) Key() string                     { return "postgres.status@1" }
func (slow) EffectStep() string              { return "effect" }
func (slow) Precondition(canon.Object) error { return nil }
func (s slow) Run(ctx context.Context, _ *verify.Job, run *Run) (canon.Object, error) {
	_ = run.Step("prepare", "succeeded", nil)
	deadline := time.Now().Add(3 * time.Second)
	for !run.Canceled() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if err := run.BeginEffect(); err != nil {
		return nil, err
	}
	close(s.effect)
	return nil, errors.New("not reached in this test")
}

func TestCancelBeforeTheEffectPoint(t *testing.T) {
	e := enrolled(t)
	s := slow{effect: make(chan struct{})}
	e.start(s)
	args := canon.Object{{Name: "cluster", Value: canon.Object{
		{Name: "localName", Value: canon.String("17/main")},
		{Name: "systemIdentifier", Value: canon.String("7291234567890123456")},
	}}}
	e.gw.Cancel(job1)
	e.gw.Enqueue(e.job(job1, nonce(1), "postgres.status", args))
	c := e.gw.WaitCompletion(t, job1, 5*time.Second)
	if c.Request.Outcome != "canceled" || !c.NR1Valid || string(c.Request.Result) != "null" {
		t.Fatalf("%+v", c.Request)
	}
	select {
	case <-s.effect:
		t.Fatal("the effect ran after a cancel")
	default:
	}
}

func TestRunCancellationRule(t *testing.T) {
	r := &Run{now: time.Now}
	r.Cancel()
	if !errors.Is(r.BeginEffect(), ErrCanceled) {
		t.Fatal("a cancel before the effect point must stop the job")
	}
	r = &Run{now: time.Now}
	if err := r.BeginEffect(); err != nil {
		t.Fatal(err)
	}
	r.Cancel()
	if r.Canceled() {
		t.Fatal("a cancel after the effect point must not stop the job")
	}
}

// failing fails before or after its effect point (control-plane.md §9.4).
type failing struct{ afterEffect bool }

func (failing) Key() string                     { return "postgres.status@1" }
func (failing) EffectStep() string              { return "write" }
func (failing) Precondition(canon.Object) error { return nil }
func (f failing) Run(_ context.Context, _ *verify.Job, run *Run) (canon.Object, error) {
	_ = run.Step("check", "succeeded", nil)
	if f.afterEffect {
		if err := run.BeginEffect(); err != nil {
			return nil, err
		}
	}
	return nil, errors.New("disk full")
}

func TestAFailedStatementSaysWhetherTheEffectBegan(t *testing.T) {
	for _, after := range []bool{false, true} {
		e := enrolled(t)
		e.start(failing{afterEffect: after})
		args := canon.Object{{Name: "cluster", Value: canon.Object{
			{Name: "localName", Value: canon.String("17/main")},
			{Name: "systemIdentifier", Value: canon.String("7291234567890123456")},
		}}}
		e.gw.Enqueue(e.job(job1, nonce(1), "postgres.status", args))
		c := e.gw.WaitCompletion(t, job1, 5*time.Second)
		if c.Request.Outcome != "failed" || !c.NR1Valid {
			t.Fatalf("%+v", c.Request)
		}
		began := false
		for _, s := range c.Request.Steps {
			if s.Name == "write" && s.State == "running" {
				began = true
			}
		}
		if began != after {
			t.Fatalf("after effect %v: steps %+v", after, c.Request.Steps)
		}
	}
}

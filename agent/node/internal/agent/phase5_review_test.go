package agent

import (
	"context"
	"io"
	"log/slog"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/testgateway"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// Regression tests for the adversarial review of Wave 5 Phase 5 and the
// failure injection of Phase 6.

// Review finding 12: the fallback statement of a completion that cannot be
// built keeps its steps, so it still says whether the effect point was
// passed.
func TestTheFallbackStatementKeepsItsSteps(t *testing.T) {
	e := enrolled(t)
	a := e.start()
	steps := []protocol.JobStep{
		{Index: 0, Name: "check", State: "succeeded", At: "2026-10-07T12:00:00Z"},
		{Index: 1, Name: "write", State: "running", At: "2026-10-07T12:00:01Z"},
	}
	bad := canon.Object{{Name: "x", Value: canon.Number(math.NaN())}}
	data, outcome, err := a.build(job1, "sha256:"+strings.Repeat("0", 64), "succeeded", "", bad, steps, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	if outcome != "failed" || !strings.Contains(s, `"outcome":"failed"`) || !strings.Contains(s, `"name":"write","state":"running"`) {
		t.Fatalf("%s", s)
	}
}

// A crash after the statement was stored and before the completion was
// journaled: the next start completes the job from its statement and
// delivers it; it is never reported interrupted.
func TestAStoredStatementCompletesACrashedJob(t *testing.T) {
	e := enrolled(t)
	first, err := New(Options{
		Config: e.cfg, Store: e.store, Version: "1.0.0", Clock: e.clk, Host: fakeHost{}, Schema: e.v,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Dial: e.gw.URL(),
	})
	if err != nil {
		t.Fatal(err)
	}
	argsHash := "sha256:" + strings.Repeat("0", 64)
	_ = first.journal.Accept(journal.Accepted{JobID: job1, OperationID: testgateway.OperationID, Capability: "agent.diagnostics@1",
		ArgsHash: argsHash, Nonce: nonce(1), IssuedAt: "2026-10-07T12:00:00Z", ExpiresAt: "2026-10-07T12:15:00Z"})
	_ = first.journal.Start(job1)
	steps := []protocol.JobStep{{Index: 0, Name: "read", State: "succeeded", At: "2026-10-07T12:00:01Z"}}
	data, _, err := first.build(job1, argsHash, "succeeded", "", canon.Object{}, steps, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.buffer.Put(job1, data); err != nil {
		t.Fatal(err)
	}
	_ = first.journal.Close()
	_ = first.nonces.Close()

	a := e.start()
	if got := a.journal.State(job1); got != journal.KindCompleted {
		t.Fatalf("recovered as %q", got)
	}
	// (The fake gateway never issued this job, so it cannot check the nr1.)
	c := e.gw.WaitCompletion(t, job1, 5*time.Second)
	if c.Request.Outcome != "succeeded" || len(c.Request.Steps) != 1 {
		t.Fatalf("%+v", c.Request)
	}
	waitFor(t, "a hello", func() bool { return len(e.gw.Hellos()) > 0 })
	for _, in := range e.gw.Hellos()[0].Journal.InFlight {
		if in.JobID == job1 {
			t.Fatal("a stated job reported in flight")
		}
	}
}

// blocking runs until its context ends.
type blocking struct{}

func (blocking) Key() string                     { return "postgres.status@1" }
func (blocking) EffectStep() string              { return "" }
func (blocking) Precondition(canon.Object) error { return nil }
func (blocking) Run(ctx context.Context, _ *verify.Job, _ *Run) (canon.Object, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// Review finding 9: a capability is stopped at its run limit and the job
// gets its statement, so the Control Plane never waits without end.
func TestACapabilityStopsAtItsRunLimit(t *testing.T) {
	e := enrolled(t)
	e.runLimit = 300 * time.Millisecond
	e.start(blocking{})
	args := canon.Object{{Name: "cluster", Value: canon.Object{
		{Name: "localName", Value: canon.String("17/main")},
		{Name: "systemIdentifier", Value: canon.String("7291234567890123456")},
	}}}
	e.gw.Enqueue(e.job(job1, nonce(1), "postgres.status", args))
	c := e.gw.WaitCompletion(t, job1, 5*time.Second)
	if c.Request.Outcome != "failed" || c.Request.OutputExcerpt == nil ||
		!strings.HasPrefix(*c.Request.OutputExcerpt, "stopped at the job's run limit") {
		t.Fatalf("%+v", c.Request)
	}
}

// The limits come from the contracts: every capability has them, and a
// restart may run and settle longer than the rest.
func TestEveryCapabilityHasItsLimits(t *testing.T) {
	e := enrolled(t)
	run, settle := e.v.Limits("postgres.restart@1")
	other, otherSettle := e.v.Limits("postgres.config.apply@1")
	if run != 720*time.Second || settle != 635*time.Second || other != 300*time.Second || otherSettle != 95*time.Second {
		t.Fatalf("%v %v %v %v", run, settle, other, otherSettle)
	}
}

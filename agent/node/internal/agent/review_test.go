package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
	"github.com/davdxpx/ExponetDB/agent/node/internal/testgateway"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// Regression tests for the adversarial review of Wave 5 Phases 1 and 2
// (findings numbered as in the review).

type movingClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *movingClock) Now() time.Time              { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *movingClock) Set(t time.Time)             { c.mu.Lock(); c.t = t; c.mu.Unlock() }
func (c *movingClock) Synchronized() (bool, error) { return true, nil }

func (e *env) startWith(clk *movingClock) (*Agent, func()) {
	a, err := New(Options{
		Config: e.cfg, Store: e.store, Version: "1.0.0", Clock: clk, Host: fakeHost{}, Schema: e.v,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		ClaimWait: 1, HeartbeatInterval: 50 * time.Millisecond, ProgressInterval: 20 * time.Millisecond,
		StartDeadline: 300 * time.Millisecond, Dial: e.gw.URL(),
	})
	if err != nil {
		e.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = a.Run(ctx) }()
	return a, func() { cancel(); <-done }
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// 1: a forged or replayed delivery never replaces a job's stored statement.
func TestForgedOrReplayedDeliveryNeverReplacesAStatement(t *testing.T) {
	e := enrolled(t)
	e.gw.FailCompletions(1 << 30)
	a := e.start()
	real := e.job(job1, nonce(1), "agent.diagnostics", noArgs())
	e.gw.Enqueue(real)
	waitFor(t, "the job's completion", func() bool { return a.buffer.Has(job1) })
	before, _ := a.buffer.Get(job1)
	forged := e.gw.Job(t, testgateway.JobKey{ID: e.gw.Key.ID, Seed: []byte(strings.Repeat("x", 32))}, job1, nonce(9), "agent.diagnostics", noArgs(), e.clk.T)
	e.gw.Enqueue(forged)
	e.gw.Enqueue(real)
	waitFor(t, "both deliveries", func() bool { return e.gw.Received(job1) >= 3 })
	after, _ := a.buffer.Get(job1)
	if string(before) != string(after) || !strings.Contains(string(after), `"outcome":"succeeded"`) {
		t.Fatalf("the stored statement changed: %s", after)
	}
	e.gw.FailCompletions(0)
	c := e.gw.WaitCompletion(t, job1, 10*time.Second)
	if c.Request.Outcome != "succeeded" || !c.NR1Valid {
		t.Fatalf("recorded %+v", c.Request)
	}
}

// 2: a host clock moved ahead and back does not let one envelope run twice.
func TestClockJumpDoesNotForgetAJob(t *testing.T) {
	e := enrolled(t)
	start := e.clk.T
	clk := &movingClock{t: start}
	_, stop := e.startWith(clk)
	envelope := e.job(job1, nonce(1), "agent.diagnostics", noArgs())
	e.gw.Enqueue(envelope)
	if c := e.gw.WaitCompletion(t, job1, 5*time.Second); c.Request.Outcome != "succeeded" {
		t.Fatalf("%+v", c.Request)
	}
	clk.Set(start.Add(91 * 24 * time.Hour))
	stop()
	a, stop := e.startWith(clk)
	defer stop()
	a.compact()
	if !a.journal.Known(job1) {
		t.Fatal("the job was forgotten on the host clock alone")
	}
	clk.Set(start.Add(time.Minute))
	e.gw.Enqueue(envelope)
	time.Sleep(500 * time.Millisecond)
	if starts := e.gw.Starts(); len(starts) != 1 {
		t.Fatalf("the envelope ran again: starts %v", starts)
	}
}

// 3: after renewal every new request presents the new certificate, even
// while an HTTP/2 stream on the old connection stays open.
func TestRenewedCertificateIsPresented(t *testing.T) {
	e := enrolled(t)
	e.gw.SlowHeartbeat = 400 * time.Millisecond
	clk := &movingClock{t: e.clk.T.Add(49 * time.Hour)}
	a, stop := e.startWith(clk)
	defer stop()
	old := ed25519.NewKeyFromSeed(state.Seed(a.id.TLSSeed)).Public().(ed25519.PublicKey)
	var renewed ed25519.PublicKey
	waitFor(t, "a renewal", func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		renewed = ed25519.NewKeyFromSeed(state.Seed(a.id.TLSSeed)).Public().(ed25519.PublicKey)
		return !renewed.Equal(old)
	})
	clk.Set(e.clk.T)
	time.Sleep(200 * time.Millisecond)
	mark := len(e.gw.SeenKeys())
	time.Sleep(1200 * time.Millisecond)
	oldCount, newCount := 0, 0
	for _, k := range e.gw.SeenKeys()[mark:] {
		switch k {
		case nodecrypto.B64U(old):
			oldCount++
		case nodecrypto.B64U(renewed):
			newCount++
		}
	}
	if oldCount != 0 || newCount == 0 {
		t.Fatalf("after renewal: %d requests with the old certificate, %d with the new one", oldCount, newCount)
	}
}

// A stop right after a renewal: the renewed identity was stored before the
// switch, so the restarted agent presents the renewed certificate only. (A
// crash before the store keeps the replaced certificate, which the gateway
// accepts until the renewed one is first used: nodes-schema.int.test.ts.)
func TestARestartAfterRenewalPresentsTheStoredCertificate(t *testing.T) {
	e := enrolled(t)
	clk := &movingClock{t: e.clk.T.Add(49 * time.Hour)}
	a, stop := e.startWith(clk)
	old := ed25519.NewKeyFromSeed(state.Seed(a.id.TLSSeed)).Public().(ed25519.PublicKey)
	var renewed ed25519.PublicKey
	waitFor(t, "a renewal", func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		renewed = ed25519.NewKeyFromSeed(state.Seed(a.id.TLSSeed)).Public().(ed25519.PublicKey)
		return !renewed.Equal(old)
	})
	stop()
	mark := len(e.gw.SeenKeys())
	_, stopAgain := e.startWith(&movingClock{t: e.clk.T})
	defer stopAgain()
	waitFor(t, "requests after the restart", func() bool { return len(e.gw.SeenKeys()) > mark+2 })
	for _, k := range e.gw.SeenKeys()[mark:] {
		if k != nodecrypto.B64U(renewed) {
			t.Fatalf("after the restart a request presented %s, not the renewed key", k)
		}
	}
}

// 5: crashed jobs beyond the contract's limit never stop hello.
func TestManyCrashedJobsStillHello(t *testing.T) {
	e := enrolled(t)
	j, err := journal.Open(e.store.Path(state.JournalDir), func() time.Time { return e.clk.T })
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 70; i++ {
		id := fmt.Sprintf("job_01JB2Z6G8M4Q7R9T1V3W5X%04d", i)
		_ = j.Accept(journal.Accepted{JobID: id, OperationID: testgateway.OperationID, Capability: "agent.diagnostics@1",
			ArgsHash: "sha256:" + strings.Repeat("0", 64), Nonce: nonce(byte(i)), IssuedAt: "2026-10-07T12:00:00Z", ExpiresAt: "2026-10-07T12:15:00Z"})
		_ = j.Start(id)
	}
	_ = j.Close()
	e.start()
	waitFor(t, "a hello", func() bool { return len(e.gw.Hellos()) > 0 })
	if n := len(e.gw.Hellos()[0].Journal.InFlight); n != journal.MaxInFlightReported {
		t.Fatalf("reported %d in flight", n)
	}
}

// 6: forged envelopes leave nothing on disk.
func TestForgedEnvelopesAreNotStored(t *testing.T) {
	e := enrolled(t)
	e.gw.FailCompletions(1 << 30)
	a := e.start()
	bad := testgateway.JobKey{ID: e.gw.Key.ID, Seed: []byte(strings.Repeat("x", 32))}
	ids := make([]string, 0, 50)
	for i := 0; i < 50; i++ {
		id := fmt.Sprintf("job_01JB2Z6G8M4Q7R9T1V3W5X%04d", i)
		ids = append(ids, id)
		e.gw.Enqueue(e.gw.Job(t, bad, id, nonce(byte(i)), "agent.diagnostics", noArgs(), e.clk.T))
	}
	waitFor(t, "every forged delivery answered", func() bool { return e.gw.Received(ids[len(ids)-1]) > 0 })
	if a.buffer.Len() != 0 || a.journal.Stats().Jobs != 0 {
		t.Fatalf("forged deliveries stored: %d buffered, %d journaled", a.buffer.Len(), a.journal.Stats().Jobs)
	}
}

// 7: a signed issuedAt ahead of the agent's clock is refused, so it can never
// become the rollback reference.
func TestFutureIssuedAtIsRefused(t *testing.T) {
	e := enrolled(t)
	e.start()
	now := e.clk.T
	sum := sha256.Sum256([]byte("{}"))
	envelope := canon.Object{
		{Name: "jobId", Value: canon.String(job1)},
		{Name: "operationId", Value: canon.String(testgateway.OperationID)},
		{Name: "nodeId", Value: canon.String(testgateway.NodeID)},
		{Name: "capability", Value: canon.Object{{Name: "name", Value: canon.String("agent.diagnostics")}, {Name: "major", Value: canon.Number(1)}}},
		{Name: "args", Value: canon.Object{}},
		{Name: "argsHash", Value: canon.String("sha256:" + hex.EncodeToString(sum[:]))},
		{Name: "notBefore", Value: canon.String(now.UTC().Format(time.RFC3339))},
		{Name: "expiresAt", Value: canon.String(now.Add(15 * time.Minute).UTC().Format(time.RFC3339))},
		{Name: "nonce", Value: canon.String(nonce(1))},
		{Name: "issuedAt", Value: canon.String(now.AddDate(5, 0, 0).UTC().Format(time.RFC3339))},
		{Name: "attempt", Value: canon.Number(1)},
	}
	signed, err := nodecrypto.SignJobEnvelope(envelope, e.gw.Key.ID, e.gw.Key.Seed)
	if err != nil {
		t.Fatal(err)
	}
	e.gw.Enqueue(signed)
	if c := e.gw.WaitCompletion(t, job1, 5*time.Second); *c.Request.RejectionReason != verify.NotYetValid {
		t.Fatalf("%+v", c.Request)
	}
	e.gw.Enqueue(e.job(job2, nonce(2), "agent.diagnostics", noArgs()))
	if c := e.gw.WaitCompletion(t, job2, 5*time.Second); c.Request.Outcome != "succeeded" {
		t.Fatalf("the next job: %+v", c.Request)
	}
}

// 9: a step named like the effect step passes the effect point, so a later
// cancel is never reported as canceled.
func TestEffectStepPassesTheEffectPoint(t *testing.T) {
	r := &Run{effect: "apply", now: time.Now}
	_ = r.Step("plan", "succeeded", nil)
	if r.EffectPassed() {
		t.Fatal("passed before the effect step")
	}
	_ = r.Step("apply", "running", nil)
	r.Cancel()
	if !r.EffectPassed() || r.Canceled() {
		t.Fatal("a cancel after the effect step took effect")
	}
	if err := r.BeginEffect(); err != nil {
		t.Fatal(err)
	}
}

// 14: a completion with more steps than the contract allows is still a valid
// request (its last steps).
func TestLongCompletionsStayValid(t *testing.T) {
	e := enrolled(t)
	a := e.start()
	steps := make([]protocol.JobStep, 300)
	for i := range steps {
		steps[i] = protocol.JobStep{Index: int64(i), Name: "step", State: "succeeded", At: "2026-10-07T12:00:00Z"}
	}
	data, _, err := a.build(job1, "sha256:"+strings.Repeat("0", 64), "succeeded", "", canon.Object{}, steps, nil)
	if err != nil {
		t.Fatal(err)
	}
	v, err := canon.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	ref, _ := e.v.MessageRef("JobCompleteRequest")
	if err := e.v.Validate(ref, v); err != nil {
		t.Fatalf("invalid completion: %v", err)
	}
	if !strings.Contains(string(data), `"index":299`) || strings.Contains(string(data), `"index":43,`) {
		t.Fatal("not the last steps")
	}
}

// Host text in an error excerpt is safe to sign and store: no U+0000 or
// other control characters, valid UTF-8, cut on a character boundary.
func TestCleanExcerpt(t *testing.T) {
	got := clean("a\x00b\x1bc\nd\te\x7f\xff", 100)
	if got != "a b c\nd\te �" {
		t.Fatalf("%q", got)
	}
	if got := clean("ééé", 3); got != "é" {
		t.Fatalf("cut %q", got)
	}
}

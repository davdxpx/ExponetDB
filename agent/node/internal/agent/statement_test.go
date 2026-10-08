package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
	"github.com/davdxpx/ExponetDB/agent/node/internal/testgateway"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// Regression tests for review finding F7: a job's one signed statement, its
// journal records and its delivery survive a failed write or a crash at
// every boundary. A crash is simulated deterministically: the boundary ends
// the agent's goroutine (runtime.Goexit) right there, with everything
// written before it synced, as a killed process leaves it; the next agent
// opens the same state directory.

// crashAt returns a boundary that kills the calling goroutine the first time
// it reaches point (for capability, or any when capability is ""), and a
// channel closed when it did.
func crashAt(capability, point string) (func(string, string), <-chan struct{}) {
	hit := make(chan struct{})
	var armed atomic.Bool
	armed.Store(true)
	return func(c, p string) {
		if p == point && (capability == "" || c == capability) && armed.CompareAndSwap(true, false) {
			close(hit)
			runtime.Goexit()
		}
	}, hit
}

func waitClosed(t *testing.T, what string, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatalf("never reached %s", what)
	}
}

// recordKinds reads the journal file and returns the kinds of jobID's
// records, in order.
func recordKinds(t *testing.T, e *env, jobID string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(e.store.Path(state.JournalDir), "journal.log"))
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, line := range bytes.Split(bytes.TrimSuffix(data, []byte("\n")), []byte("\n")) {
		var r struct {
			Kind  string `json:"kind"`
			JobID string `json:"jobId"`
		}
		if json.Unmarshal(line, &r) == nil && r.JobID == jobID {
			out = append(out, r.Kind)
		}
	}
	return out
}

func waitKinds(t *testing.T, e *env, jobID string, want ...string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		got := recordKinds(t, e, jobID)
		if slices.Equal(got, want) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("journal of %s: %v, want %v", jobID, got, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// oneStatement checks that the gateway received jobID's statement at least
// once and only ever the same bytes, and returns it.
func oneStatement(t *testing.T, e *env, jobID string) protocol.JobCompleteRequest {
	t.Helper()
	bodies := e.gw.Bodies(jobID)
	if len(bodies) == 0 {
		t.Fatalf("no statement of %s arrived", jobID)
	}
	for i, b := range bodies[1:] {
		if !bytes.Equal(b, bodies[0]) {
			t.Fatalf("statement %d of %s differs from the first:\n%s\n%s", i+1, jobID, bodies[0], b)
		}
	}
	var req protocol.JobCompleteRequest
	if err := json.Unmarshal(bodies[0], &req); err != nil {
		t.Fatal(err)
	}
	return req
}

func bufferFiles(t *testing.T, e *env) []string {
	t.Helper()
	entries, err := os.ReadDir(e.store.Path(state.BufferDir))
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, en := range entries {
		if en.Name() != ExportsClassified {
			out = append(out, en.Name())
		}
	}
	return out
}

func waitBuffer(t *testing.T, e *env, want ...string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		got := bufferFiles(t, e)
		if slices.Equal(got, want) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("buffer %v, want %v", got, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// breakBuffer makes every buffer write fail while the journal stays
// writable: the buffer directory becomes a regular file (ENOTDIR, even for
// root); mendBuffer puts the directory back.
func breakBuffer(t *testing.T, e *env) {
	t.Helper()
	dir := e.store.Path(state.BufferDir)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir, nil, 0o600); err != nil {
		t.Fatal(err)
	}
}

func mendBuffer(t *testing.T, e *env) {
	t.Helper()
	dir := e.store.Path(state.BufferDir)
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
}

// A buffer write that fails after the capability ran never closes the job:
// no terminal record, the job stays in flight, the error is noted. The next
// start stores the job's one statement (interrupted) before its terminal
// record and delivers it; the capability never runs again.
func TestABufferWriteFailureNeverClosesTheJob(t *testing.T) {
	e := enrolled(t)
	var runs atomic.Int32
	a, stop := e.launch(nil, counted{&runs})
	breakBuffer(t, e)
	e.gw.Enqueue(e.job(job1, nonce(1), "postgres.status", statusArgs()))
	waitFor(t, "the job's run", func() bool { return runs.Load() == 1 })
	stop()
	kinds := recordKinds(t, e, job1)
	if !slices.Equal(kinds, []string{"accepted", "started", "step"}) {
		t.Fatalf("a job without a stored statement was journaled as %v", kinds)
	}
	if in := a.journal.InFlight(); len(in) != 1 || in[0].JobID != job1 {
		t.Fatalf("in flight %+v", in)
	}
	if !noted(a, "not a directory") {
		t.Fatalf("the failed store was not noted: %v", a.lastErrors())
	}
	if len(e.gw.Bodies(job1)) != 0 {
		t.Fatal("a statement was sent without being stored")
	}

	mendBuffer(t, e)
	e.launch(nil, counted{&runs})
	waitKinds(t, e, job1, "accepted", "started", "step", "stated", "interrupted", "delivered")
	waitBuffer(t, e)
	c := oneStatement(t, e, job1)
	if c.Outcome != "failed" || c.OutputExcerpt == nil || !strings.HasPrefix(*c.OutputExcerpt, "interrupted") ||
		len(c.Steps) != 1 || c.Steps[0].Name != "effect" || c.Steps[0].State != "running" {
		t.Fatalf("%+v", c)
	}
	if runs.Load() != 1 || len(e.gw.Starts()) != 1 {
		t.Fatalf("ran %d times, starts %v", runs.Load(), e.gw.Starts())
	}
}

// Recovery stores a job's statement before its terminal record: when the
// statement cannot be stored, the job stays open (never terminal without
// its statement) and the next start settles it.
func TestRecoveryStoresTheStatementBeforeTheTerminalRecord(t *testing.T) {
	e := enrolled(t)
	j, err := journal.Open(e.store.Path(state.JournalDir), func() time.Time { return e.clk.T })
	if err != nil {
		t.Fatal(err)
	}
	hash := "sha256:" + strings.Repeat("0", 64)
	_ = j.Accept(journal.Accepted{JobID: job1, OperationID: testgateway.OperationID, Capability: "agent.diagnostics@1",
		ArgsHash: hash, Nonce: nonce(1), IssuedAt: "2026-10-07T12:00:00Z", ExpiresAt: "2026-10-07T12:15:00Z"})
	_ = j.Start(job1)
	_ = j.Step(job1, 0, "collect", "succeeded")
	_ = j.Accept(journal.Accepted{JobID: job2, OperationID: testgateway.OperationID, Capability: "agent.diagnostics@1",
		ArgsHash: hash, Nonce: nonce(2), IssuedAt: "2026-10-07T12:00:00Z", ExpiresAt: "2026-10-07T12:15:00Z"})
	_ = j.Close()

	breakBuffer(t, e)
	first, err := New(e.options(nil))
	if err != nil {
		t.Fatal(err)
	}
	if got := recordKinds(t, e, job1); !slices.Equal(got, []string{"accepted", "started", "step"}) {
		t.Fatalf("job 1 closed without a stored statement: %v", got)
	}
	if got := recordKinds(t, e, job2); !slices.Equal(got, []string{"accepted"}) {
		t.Fatalf("job 2 closed without a stored statement: %v", got)
	}
	_ = first.journal.Close()
	_ = first.nonces.Close()

	mendBuffer(t, e)
	e.launch(nil)
	waitKinds(t, e, job1, "accepted", "started", "step", "stated", "interrupted", "delivered")
	waitKinds(t, e, job2, "accepted", "stated", "abandoned", "delivered")
	if c := oneStatement(t, e, job1); c.Outcome != "failed" || len(c.Steps) != 1 {
		t.Fatalf("%+v", c)
	}
	if c := oneStatement(t, e, job2); c.Outcome != "rejected" || c.RejectionReason == nil || *c.RejectionReason != verify.StartUnacknowledged {
		t.Fatalf("%+v", c)
	}
	waitBuffer(t, e)
}

// A journal write that fails after the statement was stored never closes
// the job and never sends its statement as delivered; the next start
// completes the job from the stored statement and sends exactly those
// bytes. Before F7 the statement was delivered and removed, and the next
// start signed a second, different statement (interrupted).
func TestAJournalWriteFailureAfterTheStatementWasStored(t *testing.T) {
	e := enrolled(t)
	var runs atomic.Int32
	var current atomic.Pointer[Agent]
	var stored []byte
	reached := make(chan struct{})
	closeJournal := func(c, p string) {
		if p == "stored" && c == countedCap {
			a := current.Load()
			stored, _ = a.buffer.Get(job1)
			_ = a.journal.Close() // every later append fails
			close(reached)
		}
	}
	a, stop := e.launch(closeJournal, counted{&runs})
	current.Store(a)
	e.gw.Enqueue(e.job(job1, nonce(1), "postgres.status", statusArgs()))
	waitClosed(t, "stored", reached)
	waitFor(t, "the failed journal write noted", func() bool { return noted(a, "closed") })
	stop()
	if len(stored) == 0 {
		t.Fatal("nothing was stored")
	}
	if got := recordKinds(t, e, job1); !slices.Equal(got, []string{"accepted", "started", "step"}) {
		t.Fatalf("journal %v", got)
	}
	if !a.buffer.Has(job1) || len(e.gw.Bodies(job1)) != 0 {
		t.Fatalf("a statement the journal does not hold was delivered (%d deliveries)", len(e.gw.Bodies(job1)))
	}

	e.launch(nil, counted{&runs})
	waitKinds(t, e, job1, "accepted", "started", "step", "stated", "completed", "delivered")
	waitBuffer(t, e)
	oneStatement(t, e, job1)
	if !bytes.Equal(e.gw.Bodies(job1)[0], stored) {
		t.Fatal("the delivered statement is not the stored one")
	}
	if runs.Load() != 1 || len(e.gw.Starts()) != 1 {
		t.Fatalf("ran %d times", runs.Load())
	}
}

// A journal that cannot record a job's start after the gateway acknowledged
// it: nothing runs, and the job's one statement is stored before anything
// is sent; the next start settles the job from it and delivers exactly
// those bytes. Before the correction review the agent sent an unstored
// rejection and the next start signed a second, different statement.
func TestAStartTheJournalCannotRecordHasOneStatement(t *testing.T) {
	e := enrolled(t)
	var runs atomic.Int32
	var current atomic.Pointer[Agent]
	reached := make(chan struct{})
	closeJournal := func(c, p string) {
		if p == "accepted" && c == countedCap {
			_ = current.Load().journal.Close() // the start record fails
			close(reached)
		}
	}
	a, stop := e.launch(closeJournal, counted{&runs})
	current.Store(a)
	e.gw.Enqueue(e.job(job1, nonce(1), "postgres.status", statusArgs()))
	waitClosed(t, "accepted", reached)
	waitFor(t, "the failed journal write noted", func() bool { return noted(a, "closed") })
	stop()
	stored, err := a.buffer.Get(job1)
	if err != nil {
		t.Fatalf("no statement stored: %v", err)
	}

	e.launch(nil, counted{&runs})
	waitKinds(t, e, job1, "accepted", "stated", "abandoned", "delivered")
	bodies := e.gw.Bodies(job1)
	if len(bodies) == 0 {
		t.Fatal("nothing delivered")
	}
	for _, b := range bodies {
		if !bytes.Equal(b, stored) {
			t.Fatalf("a second statement was sent: %s", b)
		}
	}
	var c protocol.JobCompleteRequest
	_ = json.Unmarshal(stored, &c)
	if c.Outcome != "rejected" || c.RejectionReason == nil || *c.RejectionReason != verify.JournalCorrupt || runs.Load() != 0 {
		t.Fatalf("%+v, ran %d times", c, runs.Load())
	}
}

// A crash at each boundary of a job's statement and delivery: the next
// start settles the job, the host effect happened once, the job has one
// statement and every delivery sends the same bytes, and a later
// re-delivery of the envelope runs nothing and signs nothing.
func TestACrashAtEveryStatementBoundary(t *testing.T) {
	for _, tc := range []struct {
		point string
		// sent: deliveries before the restart.
		sent int
	}{
		{"stored", 0},       // statement stored, not journaled
		{"stated", 0},       // statement journaled, job not closed
		{"closed", 0},       // job closed, statement not sent
		{"acknowledged", 1}, // the gateway acknowledged, delivery not journaled
		{"delivered", 1},    // delivery journaled, statement not removed
	} {
		t.Run(tc.point, func(t *testing.T) {
			e := enrolled(t)
			var runs atomic.Int32
			crash, hit := crashAt(countedCap, tc.point)
			_, stop := e.launch(crash, counted{&runs})
			envelope := e.job(job1, nonce(1), "postgres.status", statusArgs())
			e.gw.Enqueue(envelope)
			waitClosed(t, tc.point, hit)
			stop()
			if got := len(e.gw.Bodies(job1)); got != tc.sent {
				t.Fatalf("%d deliveries before the crash", got)
			}

			a, _ := e.launch(nil, counted{&runs})
			waitKinds(t, e, job1, "accepted", "started", "step", "stated", "completed", "delivered")
			waitBuffer(t, e)
			c := oneStatement(t, e, job1)
			if c.Outcome != "failed" || c.OutputExcerpt == nil || !strings.Contains(*c.OutputExcerpt, "no result") {
				t.Fatalf("%+v", c)
			}
			if tc.point == "delivered" && len(e.gw.Bodies(job1)) != 1 {
				t.Fatalf("a delivered statement was sent again: %d", len(e.gw.Bodies(job1)))
			}
			sent := len(e.gw.Bodies(job1))
			e.gw.Enqueue(envelope)
			waitFor(t, "the re-delivery", func() bool { return noted(a, "delivered again") })
			if runs.Load() != 1 || len(e.gw.Starts()) != 1 || len(e.gw.Bodies(job1)) != sent {
				t.Fatalf("ran %d times, starts %v, %d deliveries (had %d)", runs.Load(), e.gw.Starts(), len(e.gw.Bodies(job1)), sent)
			}
		})
	}
}

// A crash at each boundary of recovery itself: a statement is stored before
// its stated record, which comes before the terminal record; the start after
// the crash finishes what the first began and never signs a second
// statement.
func TestACrashDuringRecovery(t *testing.T) {
	for _, capability := range []string{"agent.diagnostics@1", countedCap} {
		for _, point := range []string{"stored", "stated", "closed"} {
			t.Run(capability+"/"+point, func(t *testing.T) {
				e := enrolled(t)
				j, err := journal.Open(e.store.Path(state.JournalDir), func() time.Time { return e.clk.T })
				if err != nil {
					t.Fatal(err)
				}
				hash := "sha256:" + strings.Repeat("0", 64)
				// job1 started (interrupted at recovery), job2 accepted (abandoned).
				_ = j.Accept(journal.Accepted{JobID: job1, OperationID: testgateway.OperationID, Capability: "agent.diagnostics@1",
					ArgsHash: hash, Nonce: nonce(1), IssuedAt: "2026-10-07T12:00:00Z", ExpiresAt: "2026-10-07T12:15:00Z"})
				_ = j.Start(job1)
				_ = j.Accept(journal.Accepted{JobID: job2, OperationID: testgateway.OperationID, Capability: countedCap,
					ArgsHash: hash, Nonce: nonce(2), IssuedAt: "2026-10-07T12:00:00Z", ExpiresAt: "2026-10-07T12:15:00Z"})
				_ = j.Close()

				crash, hit := crashAt(capability, point)
				ended := make(chan struct{})
				go func() {
					defer close(ended)
					if a, err := New(e.options(crash)); err == nil {
						_ = a.journal.Close()
						_ = a.nonces.Close()
					}
				}()
				waitClosed(t, "the end of the first start", ended)
				select {
				case <-hit:
				default:
					t.Fatalf("recovery never reached %s for %s", point, capability)
				}

				e.launch(nil)
				waitKinds(t, e, job1, "accepted", "started", "stated", "interrupted", "delivered")
				waitKinds(t, e, job2, "accepted", "stated", "abandoned", "delivered")
				waitBuffer(t, e)
				if c := oneStatement(t, e, job1); c.Outcome != "failed" || !strings.HasPrefix(*c.OutputExcerpt, "interrupted") {
					t.Fatalf("%+v", c)
				}
				if c := oneStatement(t, e, job2); c.Outcome != "rejected" || *c.RejectionReason != verify.StartUnacknowledged {
					t.Fatalf("%+v", c)
				}
				if len(e.gw.Starts()) != 0 {
					t.Fatalf("starts %v", e.gw.Starts())
				}
			})
		}
	}
}

// A rejection is stored before it is journaled; a crash in between leaves a
// statement the journal does not know, which the next start adopts (the job
// becomes known, so a re-delivery never runs it) and delivers unchanged.
func TestACrashBetweenStoringAndJournalingARejection(t *testing.T) {
	e := enrolled(t)
	crash, hit := crashAt("", "stored")
	_, stop := e.launch(crash)
	expired := e.gw.Job(t, e.gw.Key, job1, nonce(1), "agent.diagnostics", noArgs(), e.clk.T.Add(-2*time.Hour))
	e.gw.Enqueue(expired)
	waitClosed(t, "stored", hit)
	stop()
	if got := recordKinds(t, e, job1); len(got) != 0 {
		t.Fatalf("journal %v", got)
	}
	a, _ := e.launch(nil)
	waitKinds(t, e, job1, "stated", "rejected", "delivered")
	waitBuffer(t, e)
	if c := oneStatement(t, e, job1); c.Outcome != "rejected" || *c.RejectionReason != verify.Expired {
		t.Fatalf("%+v", c)
	}
	sent := len(e.gw.Bodies(job1))
	e.gw.Enqueue(expired)
	waitFor(t, "the re-delivery", func() bool { return noted(a, "delivered again") })
	if len(e.gw.Bodies(job1)) != sent || len(e.gw.Starts()) != 0 {
		t.Fatalf("re-delivery answered: %d deliveries, starts %v", len(e.gw.Bodies(job1)), e.gw.Starts())
	}
}

// The gateway is unreachable: the statement waits in the buffer and every
// attempt sends the same bytes; once acknowledged, the delivery is
// journaled before the statement is removed.
func TestAGatewayOutageResendsTheSameBytes(t *testing.T) {
	e := enrolled(t)
	e.gw.FailCompletions(3)
	e.launch(nil)
	e.gw.Enqueue(e.job(job1, nonce(1), "agent.diagnostics", noArgs()))
	waitKinds(t, e, job1, "accepted", "started", "step", "stated", "completed", "delivered")
	waitBuffer(t, e)
	if c := oneStatement(t, e, job1); c.Outcome != "succeeded" || len(e.gw.Bodies(job1)) != 4 {
		t.Fatalf("%+v after %d deliveries", c, len(e.gw.Bodies(job1)))
	}
}

// The gateway recorded the statement but its acknowledgment was lost: the
// agent sends the same bytes again, the gateway answers duplicate, and only
// then is the delivery journaled.
func TestALostAcknowledgmentResendsTheSameBytes(t *testing.T) {
	e := enrolled(t)
	e.gw.LoseAcks(1)
	e.launch(nil)
	e.gw.Enqueue(e.job(job1, nonce(1), "agent.diagnostics", noArgs()))
	waitKinds(t, e, job1, "accepted", "started", "step", "stated", "completed", "delivered")
	waitBuffer(t, e)
	oneStatement(t, e, job1)
	if n := len(e.gw.Bodies(job1)); n != 2 {
		t.Fatalf("%d deliveries", n)
	}
}

// A statement the gateway refuses for good is parked for the operator and
// journaled as parked: it counts as stored, is never sent again, never
// regenerated, and not an anomaly at the next start.
func TestAParkedStatementIsSettled(t *testing.T) {
	e := enrolled(t)
	e.gw.RefuseCompletions(job1)
	_, stop := e.launch(nil)
	envelope := e.job(job1, nonce(1), "agent.diagnostics", noArgs())
	e.gw.Enqueue(envelope)
	waitKinds(t, e, job1, "accepted", "started", "step", "stated", "completed", "parked")
	waitBuffer(t, e, job1+".refused")
	stop()

	a, _ := e.launch(nil)
	e.gw.Enqueue(envelope)
	waitFor(t, "the re-delivery", func() bool { return noted(a, "delivered again") })
	if n := len(e.gw.Bodies(job1)); n != 1 {
		t.Fatalf("a parked statement was sent %d times", n)
	}
	for _, msg := range a.lastErrors() {
		if strings.Contains(msg, "anomaly") {
			t.Fatalf("a parked statement reported as an anomaly: %s", msg)
		}
	}
	if got := recordKinds(t, e, job1); got[len(got)-1] != "parked" {
		t.Fatalf("journal %v", got)
	}
	waitBuffer(t, e, job1+".refused")
}

// Re-deliveries while the statement is pending get the same bytes again;
// the late acknowledgment is journaled; a re-delivery after that gets
// nothing.
func TestDuplicateAndLateDeliveries(t *testing.T) {
	e := enrolled(t)
	var runs atomic.Int32
	e.gw.FailCompletions(1 << 30)
	a, _ := e.launch(nil, counted{&runs})
	envelope := e.job(job1, nonce(1), "postgres.status", statusArgs())
	e.gw.Enqueue(envelope)
	waitKinds(t, e, job1, "accepted", "started", "step", "stated", "completed")
	e.gw.Enqueue(envelope)
	waitFor(t, "the re-delivery", func() bool { return noted(a, "delivered again") })
	e.gw.FailCompletions(0)
	waitKinds(t, e, job1, "accepted", "started", "step", "stated", "completed", "delivered")
	waitBuffer(t, e)
	sent := len(e.gw.Bodies(job1))
	before := a.lastErrors()
	e.gw.Enqueue(envelope)
	waitFor(t, "the second re-delivery", func() bool {
		errs := a.lastErrors()
		return !slices.Equal(errs, before) && strings.Contains(errs[len(errs)-1], "delivered again")
	})
	oneStatement(t, e, job1)
	if len(e.gw.Bodies(job1)) != sent || runs.Load() != 1 || len(e.gw.Starts()) != 1 {
		t.Fatalf("%d deliveries (had %d), ran %d times", len(e.gw.Bodies(job1)), sent, runs.Load())
	}
}

// A journal written by the previous release (format 1: no stated, delivered
// or parked records; testdata/journal-format1 was produced by that code)
// replays and recovers: its terminal jobs keep the previous behavior (a
// pending statement is delivered and removed), its open jobs are settled
// statement first, and no job gets a second statement.
func TestAFormat1JournalIsUpgraded(t *testing.T) {
	e := enrolled(t)
	const (
		f1 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y11" // completed, delivered
		f2 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y12" // completed, pending
		f3 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y13" // rejected, pending
		f4 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y14" // abandoned, pending
		f5 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y15" // interrupted, pending
		f6 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y16" // started, nothing stored
		f7 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y17" // started, statement stored
		f8 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y18" // accepted, start never acknowledged
		f9 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y19" // rejected, delivered
	)
	// The statements the previous release left in the buffer, signed with
	// this node's key.
	signer, err := New(e.options(nil))
	if err != nil {
		t.Fatal(err)
	}
	hash := digestOf([]byte("{}"))
	steps := []protocol.JobStep{{Index: 0, Name: "collect", State: "succeeded", At: "2026-10-07T12:00:04Z"}}
	interrupted := "interrupted: the agent stopped while running this job; it is never resumed"
	stored := map[string][]byte{}
	for id, s := range map[string]struct {
		outcome, reason string
		excerpt         *string
	}{
		f2: {outcome: "succeeded"}, f3: {outcome: "rejected", reason: verify.Expired},
		f4: {outcome: "rejected", reason: verify.StartUnacknowledged}, f5: {outcome: "failed", excerpt: &interrupted},
		f7: {outcome: "succeeded"},
	} {
		var result canon.Object
		var st []protocol.JobStep
		if s.outcome != "rejected" {
			st = steps
		}
		if s.outcome == "succeeded" {
			result = canon.Object{}
		}
		data, err := signer.sign(id, hash, s.outcome, s.reason, result, st, s.excerpt)
		if err != nil {
			t.Fatal(err)
		}
		if err := signer.buffer.Put(id, data); err != nil {
			t.Fatal(err)
		}
		stored[id] = data
	}
	_ = signer.journal.Close()
	_ = signer.nonces.Close()
	for _, name := range []string{"journal.log", "nonces.log"} {
		data, err := os.ReadFile(filepath.Join("testdata", "journal-format1", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(e.store.Path(state.JournalDir), name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// The previous release classified nothing and marked nothing.
	if err := os.Remove(filepath.Join(e.store.Path(state.BufferDir), ExportsClassified)); err != nil {
		t.Fatal(err)
	}

	a, _ := e.launch(nil)
	waitKinds(t, e, f6, "accepted", "started", "step", "stated", "interrupted", "delivered")
	// Its statement, adopted as it is and parked: never sent (F1).
	waitKinds(t, e, f7, "accepted", "started", "step", "stated", "completed", "parked")
	waitKinds(t, e, f8, "accepted", "stated", "abandoned", "delivered")
	// What the previous release stored is parked, except bare rejections.
	waitBuffer(t, e, f2+".refused", f5+".refused", f7+".refused")
	for id, data := range stored {
		switch id {
		case f3, f4:
			oneStatement(t, e, id)
			if !bytes.Equal(e.gw.Bodies(id)[0], data) {
				t.Fatalf("%s: the delivered statement is not the stored one", id)
			}
		default:
			if n := len(e.gw.Bodies(id)); n != 0 {
				t.Fatalf("%s: a statement of the previous release was sent %d times", id, n)
			}
		}
	}
	// Format-1 terminal jobs get no new records.
	for id, want := range map[string][]string{
		f1: {"accepted", "started", "step", "completed"}, f2: {"accepted", "started", "step", "completed"},
		f3: {"rejected"}, f4: {"accepted", "abandoned"}, f5: {"accepted", "started", "step", "interrupted"},
		f9: {"rejected"},
	} {
		if got := recordKinds(t, e, id); !slices.Equal(got, want) {
			t.Fatalf("%s: %v, want %v", id, got, want)
		}
	}
	if c := oneStatement(t, e, f6); c.Outcome != "failed" || len(c.Steps) != 1 || c.Steps[0].Name != "collect" {
		t.Fatalf("%+v", c)
	}
	if c := oneStatement(t, e, f8); c.Outcome != "rejected" || *c.RejectionReason != verify.StartUnacknowledged {
		t.Fatalf("%+v", c)
	}
	// Delivered jobs of the previous release are known: nothing is sent.
	for i, id := range []string{f1, f9} {
		e.gw.Enqueue(e.job(id, nonce(byte(40+i)), "agent.diagnostics", noArgs()))
	}
	waitFor(t, "the re-deliveries", func() bool {
		n := 0
		for _, msg := range a.lastErrors() {
			if strings.Contains(msg, "delivered again") {
				n++
			}
		}
		return n == 2
	})
	if len(e.gw.Bodies(f1)) != 0 || len(e.gw.Bodies(f9)) != 0 || len(e.gw.Starts()) != 0 {
		t.Fatal(fmt.Sprintf("re-delivered jobs answered: %d %d, starts %v", len(e.gw.Bodies(f1)), len(e.gw.Bodies(f9)), e.gw.Starts()))
	}
}

// Statements a release before the export correction stored are never sent
// (capabilities.md §6, Wave 5 correction F1): the first start of this
// release parks every one but a bare rejection, before recovery and before
// any delivery, and marks the buffer so that the pass runs once. The jobs
// are still settled from the parked bytes, never signed again.
func TestStatementsOfAnEarlierReleaseAreNeverSent(t *testing.T) {
	e := enrolled(t)
	const canary = "exdb-canary-7f3e9a1c"
	j := prepare(t, e)
	hash := "sha256:" + strings.Repeat("0", 64)
	_ = j.Accept(journal.Accepted{JobID: job3, OperationID: testgateway.OperationID, Capability: "postgres.status@1",
		ArgsHash: hash, Nonce: nonce(3), IssuedAt: "2026-10-07T12:00:00Z", ExpiresAt: "2026-10-07T12:15:00Z"})
	_ = j.Start(job3)
	_ = j.Close()
	// What the earlier release stored: a result with a host value it did not
	// classify, a failure quoting PostgreSQL, and a bare rejection.
	signer := &Agent{o: e.options(nil), st: mustState(t, e), id: mustIdentity(t, e), buffer: &Buffer{dir: e.store.Path(state.BufferDir)}}
	steps := []protocol.JobStep{{Index: 0, Name: "collect", State: "succeeded", At: "2026-10-07T12:00:04Z"}}
	result := canon.Object{{Name: "settings", Value: canon.Array{canon.Object{
		{Name: "name", Value: canon.String("primary_conninfo")},
		{Name: "setting", Value: canon.String("host=10.0.0.9 user=replicator password=" + canary)},
	}}}}
	excerpt := `ERROR: invalid value for parameter "x": "` + canary + `"`
	for _, s := range []struct {
		id, outcome, reason string
		result              canon.Object
		steps               []protocol.JobStep
		excerpt             *string
	}{
		{id: job1, outcome: "succeeded", result: result, steps: steps},
		{id: job2, outcome: "rejected", reason: verify.StartUnacknowledged},
		{id: job3, outcome: "failed", excerpt: &excerpt},
	} {
		data, err := signer.sign(s.id, hash, s.outcome, s.reason, s.result, s.steps, s.excerpt)
		if err != nil {
			t.Fatal(err)
		}
		if err := signer.buffer.Put(s.id, data); err != nil {
			t.Fatal(err)
		}
	}
	marker := filepath.Join(e.store.Path(state.BufferDir), ExportsClassified)
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}

	a, stop := e.launch(nil)
	waitKinds(t, e, job1, "accepted", "started", "step", "stated", "completed", "parked")
	waitKinds(t, e, job3, "accepted", "started", "stated", "completed", "parked")
	waitKinds(t, e, job2, "accepted", "stated", "abandoned", "delivered")
	waitBuffer(t, e, job1+".refused", job3+".refused")
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("the buffer is not marked: %v", err)
	}
	if len(e.gw.Bodies(job1)) != 0 || len(e.gw.Bodies(job3)) != 0 || len(e.gw.Bodies(job2)) != 1 {
		t.Fatalf("sent %d, %d, %d", len(e.gw.Bodies(job1)), len(e.gw.Bodies(job3)), len(e.gw.Bodies(job2)))
	}
	for _, msg := range a.lastErrors() {
		if strings.Contains(msg, canary) {
			t.Fatalf("lastErrors holds the canary: %q", msg)
		}
	}
	stop()

	// The pass ran once: a later start sends nothing of them either.
	e.launch(nil)
	e.gw.Enqueue(e.job(job4, nonce(4), "agent.diagnostics", noArgs()))
	waitFor(t, "a later job", func() bool { return len(e.gw.Bodies(job4)) == 1 })
	if len(e.gw.Bodies(job1)) != 0 || len(e.gw.Bodies(job3)) != 0 {
		t.Fatal("a statement of the earlier release was sent after the pass")
	}
	if bytes.Contains(e.gw.Bodies(job4)[0], []byte(canary)) || bytes.Contains(e.gw.Bodies(job2)[0], []byte(canary)) {
		t.Fatal("a sent statement holds the canary")
	}
}

// prepare journals job1 (started, one step) and job2 (accepted) and returns
// the journal, still open, for a test to add to.
func prepare(t *testing.T, e *env) *journal.Journal {
	t.Helper()
	j, err := journal.Open(e.store.Path(state.JournalDir), func() time.Time { return e.clk.T })
	if err != nil {
		t.Fatal(err)
	}
	hash := "sha256:" + strings.Repeat("0", 64)
	_ = j.Accept(journal.Accepted{JobID: job1, OperationID: testgateway.OperationID, Capability: "agent.diagnostics@1",
		ArgsHash: hash, Nonce: nonce(1), IssuedAt: "2026-10-07T12:00:00Z", ExpiresAt: "2026-10-07T12:15:00Z"})
	_ = j.Start(job1)
	_ = j.Step(job1, 0, "collect", "succeeded")
	_ = j.Accept(journal.Accepted{JobID: job2, OperationID: testgateway.OperationID, Capability: "agent.diagnostics@1",
		ArgsHash: hash, Nonce: nonce(2), IssuedAt: "2026-10-07T12:00:00Z", ExpiresAt: "2026-10-07T12:15:00Z"})
	return j
}

// A statement the journal records as stored but the buffer no longer holds
// (and that was never delivered) is reported, never signed again: the job
// stays open and in flight, and nothing is sent for it.
func TestAStatedStatementThatIsGoneIsNeverRegenerated(t *testing.T) {
	e := enrolled(t)
	j := prepare(t, e)
	if err := j.Stated(job1, digestOf([]byte("a statement the buffer lost")), "succeeded"); err != nil {
		t.Fatal(err)
	}
	_ = j.Close()
	a, _ := e.launch(nil)
	waitKinds(t, e, job2, "accepted", "stated", "abandoned", "delivered")
	if got := recordKinds(t, e, job1); !slices.Equal(got, []string{"accepted", "started", "step", "stated"}) {
		t.Fatalf("journal %v", got)
	}
	if !noted(a, "anomaly") || len(e.gw.Bodies(job1)) != 0 {
		t.Fatalf("errors %v, %d deliveries", a.lastErrors(), len(e.gw.Bodies(job1)))
	}
	if in := a.journal.InFlight(); len(in) != 1 || in[0].JobID != job1 {
		t.Fatalf("in flight %+v", in)
	}
	waitFor(t, "a hello", func() bool { return len(e.gw.Hellos()) > 0 })
	if in := e.gw.Hellos()[0].Journal.InFlight; len(in) != 1 || in[0].JobID != job1 {
		t.Fatalf("hello in flight %+v", in)
	}
}

// A stored statement whose bytes no longer match the digest its stated
// record holds is never sent and never replaced: the agent refuses every
// job (journal_corrupt) until a local operator repairs it.
func TestAChangedStatementRefusesEveryJob(t *testing.T) {
	e := enrolled(t)
	j := prepare(t, e)
	signer := &Agent{o: e.options(nil), st: mustState(t, e), id: mustIdentity(t, e), buffer: &Buffer{dir: e.store.Path(state.BufferDir)}}
	data, _, err := signer.build(job1, j.ArgsHash(job1), "succeeded", "", canon.Object{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := j.Stated(job1, digestOf(data), "succeeded"); err != nil {
		t.Fatal(err)
	}
	_ = j.Close()
	changed := bytes.Replace(data, []byte(`"succeeded"`), []byte(`"failed"`), 1)
	if err := signer.buffer.Put(job1, changed); err != nil {
		t.Fatal(err)
	}
	var runs atomic.Int32
	a, _ := e.launch(nil, counted{&runs})
	if !errors.Is(a.brokenErr(), errIntegrity) {
		t.Fatalf("broken %v", a.brokenErr())
	}
	e.gw.Enqueue(e.job(job3, nonce(3), "postgres.status", statusArgs()))
	waitFor(t, "the refusal", func() bool { return len(e.gw.Bodies(job3)) == 1 })
	var refusal protocol.JobCompleteRequest
	_ = json.Unmarshal(e.gw.Bodies(job3)[0], &refusal)
	if refusal.RejectionReason == nil || *refusal.RejectionReason != verify.JournalCorrupt || runs.Load() != 0 {
		t.Fatalf("%+v, ran %d times", refusal, runs.Load())
	}
	if got := recordKinds(t, e, job1); !slices.Equal(got, []string{"accepted", "started", "step", "stated"}) {
		t.Fatalf("journal %v", got)
	}
	if held, _ := signer.buffer.Get(job1); !bytes.Equal(held, changed) {
		t.Fatal("the changed statement was replaced")
	}
	if n := len(e.gw.Bodies(job1)); n != 0 {
		t.Fatalf("a changed statement was sent %d times", n)
	}
}

// A pending statement that changes while the agent runs is never sent: the
// delivery checks the stored bytes against the journaled digest first.
func TestAStatementChangedWhileRunningIsNeverSent(t *testing.T) {
	e := enrolled(t)
	e.gw.FailCompletions(1 << 30)
	a, _ := e.launch(nil)
	e.gw.Enqueue(e.job(job1, nonce(1), "agent.diagnostics", noArgs()))
	waitKinds(t, e, job1, "accepted", "started", "step", "stated", "completed")
	stored, err := a.buffer.Get(job1)
	if err != nil {
		t.Fatal(err)
	}
	changed := bytes.Replace(stored, []byte(`"succeeded"`), []byte(`"failed"`), 1)
	if err := os.WriteFile(filepath.Join(e.store.Path(state.BufferDir), job1+".json"), changed, 0o600); err != nil {
		t.Fatal(err)
	}
	e.gw.FailCompletions(0)
	waitFor(t, "the integrity failure", func() bool { return errors.Is(a.brokenErr(), errIntegrity) })
	for _, b := range e.gw.Bodies(job1) {
		if !bytes.Equal(b, stored) {
			t.Fatalf("sent bytes that are not the journaled statement: %s", b)
		}
	}
	e.gw.Enqueue(e.job(job2, nonce(2), "agent.diagnostics", noArgs()))
	waitFor(t, "the refusal", func() bool { return len(e.gw.Bodies(job2)) == 1 })
	if c := oneStatement(t, e, job2); c.RejectionReason == nil || *c.RejectionReason != verify.JournalCorrupt {
		t.Fatalf("%+v", c)
	}
}

// A statement parked before its parked record was written (a crash between
// the two), and one stored and parked before its stated record: the next
// start journals them as they are, never sends them and never signs again.
func TestAParkedStatementWithoutItsRecord(t *testing.T) {
	e := enrolled(t)
	j := prepare(t, e)
	signer := &Agent{o: e.options(nil), st: mustState(t, e), id: mustIdentity(t, e), buffer: &Buffer{dir: e.store.Path(state.BufferDir)}}
	first, _, err := signer.build(job1, j.ArgsHash(job1), "succeeded", "", canon.Object{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := signer.build(job2, j.ArgsHash(job2), "rejected", verify.StartUnacknowledged, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = j.Stated(job1, digestOf(first), "succeeded")
	_ = j.Complete(job1, "succeeded")
	_ = j.Close()
	for id, data := range map[string][]byte{job1: first, job2: second} {
		if err := signer.buffer.Put(id, data); err != nil {
			t.Fatal(err)
		}
		if err := signer.buffer.Park(id); err != nil {
			t.Fatal(err)
		}
	}
	a, _ := e.launch(nil)
	waitKinds(t, e, job1, "accepted", "started", "step", "stated", "completed", "parked")
	waitKinds(t, e, job2, "accepted", "stated", "abandoned", "parked")
	if p, _ := a.journal.Position(job2); p.Digest != digestOf(second) {
		t.Fatalf("%+v", p)
	}
	if len(e.gw.Bodies(job1))+len(e.gw.Bodies(job2)) != 0 || len(a.journal.Unsettled()) != 0 {
		t.Fatal("a parked statement was sent or left unsettled")
	}
	waitBuffer(t, e, job1+".refused", job2+".refused")
}

func mustState(t *testing.T, e *env) *state.State {
	t.Helper()
	st, err := e.store.LoadState()
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func mustIdentity(t *testing.T, e *env) *state.Identity {
	t.Helper()
	id, err := e.store.LoadIdentity()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// A statement stored for a job the journal does not know yet (its stated
// record failed) makes the job known: a delivery of it never runs it, and
// the statement waits for the next start, which adopts it.
func TestAHeldStatementKeepsItsJobFromRunning(t *testing.T) {
	e := enrolled(t)
	var runs atomic.Int32
	a, stop := e.launch(nil, counted{&runs})
	envelope := e.job(job1, nonce(1), "postgres.status", statusArgs())
	data, _, err := a.build(job1, "sha256:"+strings.Repeat("0", 64), "rejected", verify.ClockUntrusted, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.buffer.Put(job1, data); err != nil {
		t.Fatal(err)
	}
	e.gw.Enqueue(envelope)
	waitFor(t, "the delivery", func() bool { return noted(a, "delivered again") })
	stop()
	if runs.Load() != 0 || len(e.gw.Starts()) != 0 || len(e.gw.Bodies(job1)) != 0 {
		t.Fatalf("ran %d times, starts %v, %d deliveries", runs.Load(), e.gw.Starts(), len(e.gw.Bodies(job1)))
	}
	e.launch(nil, counted{&runs})
	waitKinds(t, e, job1, "stated", "rejected", "delivered")
	if !bytes.Equal(e.gw.Bodies(job1)[0], data) || runs.Load() != 0 {
		t.Fatal("not the held statement")
	}
}

// The gateway acknowledged a statement but the delivery cannot be journaled:
// the statement stays (never removed without its delivered record), is not
// sent again by this process, and the next start sends the same bytes, which
// the gateway answers duplicate.
func TestAnAcknowledgedDeliveryThatCannotBeJournaled(t *testing.T) {
	e := enrolled(t)
	var current atomic.Pointer[Agent]
	closeJournal := func(c, p string) {
		if p == "acknowledged" {
			_ = current.Load().journal.Close()
		}
	}
	a, stop := e.launch(closeJournal)
	current.Store(a)
	e.gw.Enqueue(e.job(job1, nonce(1), "agent.diagnostics", noArgs()))
	waitFor(t, "the failed delivery record", func() bool { return noted(a, "acknowledged, not journaled") })
	// The next job is refused (the journal is broken); its answer comes
	// after at least one more pass over the buffer.
	e.gw.Enqueue(e.job(job2, nonce(2), "agent.diagnostics", noArgs()))
	waitFor(t, "the refusal", func() bool { return len(e.gw.Bodies(job2)) == 1 })
	stop()
	if n := len(e.gw.Bodies(job1)); n != 1 || !a.buffer.Has(job1) {
		t.Fatalf("%d deliveries, held %v", n, a.buffer.Has(job1))
	}
	e.launch(nil)
	waitKinds(t, e, job1, "accepted", "started", "step", "stated", "completed", "delivered")
	waitBuffer(t, e)
	oneStatement(t, e, job1)
	if n := len(e.gw.Bodies(job1)); n != 2 {
		t.Fatalf("%d deliveries", n)
	}
}

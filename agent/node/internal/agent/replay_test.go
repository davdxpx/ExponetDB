package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// Regression test for review finding F7 (replay state) and the helpers the
// F7 tests share.

// options are the agent options of these tests.
func (e *env) options(boundary func(capability, point string), caps ...Capability) Options {
	return Options{
		Config: e.cfg, Store: e.store, Version: "1.0.0", Clock: e.clk, Host: fakeHost{}, Schema: e.v,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Capabilities: caps,
		ClaimWait: 1, HeartbeatInterval: 50 * time.Millisecond, ProgressInterval: 20 * time.Millisecond,
		StartDeadline: 300 * time.Millisecond, Dial: e.gw.URL(), Boundary: boundary,
	}
}

// launch runs an agent with a boundary; stop ends its loop and waits for it.
func (e *env) launch(boundary func(capability, point string), caps ...Capability) (*Agent, func()) {
	e.t.Helper()
	a, err := New(e.options(boundary, caps...))
	if err != nil {
		e.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = a.Run(ctx) }()
	var once sync.Once
	stop := func() { once.Do(func() { cancel(); <-done }) }
	e.t.Cleanup(stop)
	return a, stop
}

// counted is a capability with an effect that counts its runs: the host
// effect of a job must happen once.
type counted struct{ runs *atomic.Int32 }

func (counted) Key() string                     { return "postgres.status@1" }
func (counted) EffectStep() string              { return "effect" }
func (counted) Precondition(canon.Object) error { return nil }
func (c counted) Run(_ context.Context, _ *verify.Job, run *Run) (canon.Object, error) {
	if err := run.BeginEffect(); err != nil {
		return nil, err
	}
	c.runs.Add(1)
	return nil, errors.New("the stand-in reports no result")
}

const countedCap = "postgres.status@1"

func statusArgs() canon.Object {
	return canon.Object{{Name: "cluster", Value: canon.Object{
		{Name: "localName", Value: canon.String("17/main")},
		{Name: "systemIdentifier", Value: canon.String("7291234567890123456")},
	}}}
}

func noted(a *Agent, text string) bool {
	for _, e := range a.lastErrors() {
		if strings.Contains(e, text) {
			return true
		}
	}
	return false
}

// After both replay files were lost while the node stays enrolled, the agent
// refuses every job (journal_corrupt) instead of recreating them: the same
// envelope never runs twice.
func TestLostReplayFilesRefuseEveryJob(t *testing.T) {
	e := enrolled(t)
	var runs atomic.Int32
	_, stop := e.launch(nil, counted{&runs})
	envelope := e.job(job1, nonce(1), "postgres.status", statusArgs())
	e.gw.Enqueue(envelope)
	waitFor(t, "the statement", func() bool { return len(e.gw.Bodies(job1)) == 1 })
	stop()
	for _, name := range []string{"journal.log", "nonces.log"} {
		if err := os.Remove(filepath.Join(e.store.Path(state.JournalDir), name)); err != nil {
			t.Fatal(err)
		}
	}
	a, _ := e.launch(nil, counted{&runs})
	e.gw.Enqueue(envelope)
	waitFor(t, "the refusal", func() bool { return len(e.gw.Bodies(job1)) == 2 })
	var refusal protocol.JobCompleteRequest
	if err := json.Unmarshal(e.gw.Bodies(job1)[1], &refusal); err != nil {
		t.Fatal(err)
	}
	if runs.Load() != 1 || len(e.gw.Starts()) != 1 || refusal.RejectionReason == nil || *refusal.RejectionReason != verify.JournalCorrupt {
		t.Fatalf("ran %d times, starts %v, answer %+v", runs.Load(), e.gw.Starts(), refusal)
	}
	if !noted(a, "missing") {
		t.Fatalf("the lost replay state was not noted: %v", a.lastErrors())
	}
	for _, name := range []string{"journal.log", "nonces.log"} {
		if _, err := os.Stat(filepath.Join(e.store.Path(state.JournalDir), name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s was recreated: %v", name, err)
		}
	}
}

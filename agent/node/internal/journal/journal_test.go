package journal

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type testClock struct{ t time.Time }

func (c *testClock) now() time.Time { return c.t }

func newClock() *testClock {
	return &testClock{t: time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)}
}

func accepted(id, nonce string) Accepted {
	return Accepted{
		JobID: id, OperationID: "op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z", Capability: "postgres.reload@1",
		ArgsHash: "sha256:" + string(bytes.Repeat([]byte("a"), 64)), Nonce: nonce,
		IssuedAt: "2026-10-07T12:00:00Z", ExpiresAt: "2026-10-07T12:15:00Z",
	}
}

const (
	job1 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y01"
	job2 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y02"
	job3 = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y03"
)

// testDigest stands for the sha256 of a stored statement.
var testDigest = "sha256:" + string(bytes.Repeat([]byte("b"), 64))

// mustOpen opens the journal in dir, initializing the replay files on first
// use (as enrollment does).
func mustOpen(t *testing.T, dir string, c *testClock) *Journal {
	t.Helper()
	if err := Init(dir); err != nil {
		t.Fatal(err)
	}
	j, err := Open(dir, c.now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = j.Close() })
	return j
}

func TestLifecycleSurvivesReopen(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	j := mustOpen(t, dir, c)
	for _, step := range []func() error{
		func() error { return j.Accept(accepted(job1, "AAECAwQFBgcICQoLDA0ODw")) },
		func() error { return j.Start(job1) },
		func() error { return j.Step(job1, 0, "validate", "succeeded") },
		func() error { return j.Step(job1, 1, "reload", "succeeded") },
		func() error { return j.Accept(accepted(job2, "AQECAwQFBgcICQoLDA0ODw")) },
		func() error { return j.Start(job2) },
		func() error { return j.Stated(job2, testDigest, "succeeded") },
		func() error { return j.Complete(job2, "succeeded") },
		func() error { return j.Stated(job3, testDigest, "rejected") },
		func() error { return j.Reject(job3, "nonce_replayed") },
	} {
		if err := step(); err != nil {
			t.Fatal(err)
		}
	}
	_ = j.Close()
	j = mustOpen(t, dir, c)
	if !j.Known(job1) || !j.Known(job2) || !j.Known(job3) || j.Known("job_01JB2Z6G8M4Q7R9T1V3W5X7Y04") {
		t.Fatal("known jobs")
	}
	inFlight := j.InFlight()
	if len(inFlight) != 1 || inFlight[0].JobID != job1 || inFlight[0].LastStep != 1 {
		t.Fatalf("in flight: %+v", inFlight)
	}
	if j.State(job2) != KindCompleted || j.State(job3) != KindRejected {
		t.Fatal("states")
	}
}

func TestTransitionsAreEnforced(t *testing.T) {
	j := mustOpen(t, t.TempDir(), newClock())
	if err := j.Start(job1); !errors.Is(err, ErrState) {
		t.Fatalf("start without accept: %v", err)
	}
	if err := j.Accept(accepted(job1, "n1")); err != nil {
		t.Fatal(err)
	}
	if err := j.Accept(accepted(job1, "n1")); !errors.Is(err, ErrState) {
		t.Fatalf("accepted twice: %v", err)
	}
	if err := j.Complete(job1, "succeeded"); !errors.Is(err, ErrState) {
		t.Fatalf("complete without start: %v", err)
	}
	// A terminal record never precedes the job's statement (F7).
	if err := j.Abandon(job1); !errors.Is(err, ErrState) {
		t.Fatalf("abandon without a statement: %v", err)
	}
	if err := j.Stated(job1, "sha256:short", "rejected"); !errors.Is(err, ErrState) {
		t.Fatalf("stated without a digest: %v", err)
	}
	if err := j.Stated(job1, testDigest, "rejected"); err != nil {
		t.Fatal(err)
	}
	if err := j.Stated(job1, testDigest, "rejected"); !errors.Is(err, ErrState) {
		t.Fatalf("stated twice: %v", err)
	}
	if err := j.Start(job1); !errors.Is(err, ErrState) {
		t.Fatalf("start after the statement: %v", err)
	}
	if err := j.Delivered(job1); !errors.Is(err, ErrState) {
		t.Fatalf("delivered before the terminal record: %v", err)
	}
	if err := j.Abandon(job1); err != nil {
		t.Fatal(err)
	}
	if err := j.Start(job1); !errors.Is(err, ErrState) {
		t.Fatalf("start after abandon: %v", err)
	}
	if err := j.Delivered(job1); err != nil {
		t.Fatal(err)
	}
	if err := j.Parked(job1); !errors.Is(err, ErrState) {
		t.Fatalf("parked after delivered: %v", err)
	}
	// A terminal record must fit the statement.
	_ = j.Accept(accepted(job2, "n2"))
	_ = j.Start(job2)
	_ = j.Stated(job2, testDigest, "failed")
	if err := j.Complete(job2, "succeeded"); !errors.Is(err, ErrState) {
		t.Fatalf("a completion that contradicts its statement: %v", err)
	}
	if err := j.Complete(job2, "failed"); err != nil {
		t.Fatal(err)
	}
}

// The transition table is closed: every position it names maps to known
// kinds, every kind a journal can hold appears, and the format-1 transitions
// are in it (so a format-1 journal replays) but are never written.
func TestTheTransitionTableIsClosed(t *testing.T) {
	kinds := map[string]bool{KindAccepted: true, KindStarted: true, KindStep: true, KindCompleted: true, KindRejected: true,
		KindAbandoned: true, KindInterrupted: true, KindStated: true, KindDelivered: true, KindParked: true}
	seen := map[string]bool{}
	for from, tos := range allowed {
		for _, to := range tos {
			if !kinds[to] {
				t.Fatalf("%q -> unknown kind %q", from, to)
			}
			seen[to] = true
		}
	}
	for k := range kinds {
		if !seen[k] {
			t.Fatalf("kind %q is never allowed", k)
		}
	}
	for tr := range format1 {
		if !permitted(tr[0], tr[1]) {
			t.Fatalf("format-1 transition %v does not replay", tr)
		}
	}
	if Format != 2 {
		t.Fatalf("format %d", Format)
	}
}

func TestTornFinalLineIsCutOff(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	j := mustOpen(t, dir, c)
	if err := j.Accept(accepted(job1, "n1")); err != nil {
		t.Fatal(err)
	}
	_ = j.Close()
	path := filepath.Join(dir, "journal.log")
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString(`{"at":"2026-10-07T12:00:01Z","hash":"sha256:`)
	_ = f.Close()
	j = mustOpen(t, dir, c)
	if j.State(job1) != KindAccepted {
		t.Fatal("lost the synced record")
	}
	if err := j.Start(job1); err != nil {
		t.Fatalf("append after cut: %v", err)
	}
	data, _ := os.ReadFile(path)
	if !bytes.HasSuffix(data, []byte("}\n")) || bytes.Count(data, []byte("\n")) != 2 {
		t.Fatalf("file after cut: %q", data)
	}
}

func TestDamageIsCorruption(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	j := mustOpen(t, dir, c)
	_ = j.Accept(accepted(job1, "n1"))
	_ = j.Start(job1)
	_ = j.Stated(job1, testDigest, "succeeded")
	_ = j.Complete(job1, "succeeded")
	_ = j.Close()
	path := filepath.Join(dir, "journal.log")
	data, _ := os.ReadFile(path)
	lines := bytes.SplitAfter(data, []byte("\n"))[:3]
	for name, damaged := range map[string][]byte{
		"changed byte":   bytes.Replace(data, []byte("succeeded"), []byte("failed\x20\x20\x20"), 1),
		"removed middle": append(append([]byte{}, lines[0]...), lines[2]...),
		"reordered":      append(append(append([]byte{}, lines[1]...), lines[0]...), lines[2]...),
		"duplicated":     append(append([]byte{}, data...), lines[2]...),
		"not canonical":  bytes.Replace(data, []byte(`{"argsHash"`), []byte(`{ "argsHash"`), 1),
		"garbage line":   append(append([]byte{}, data...), []byte("garbage\n")...),
		"empty line":     append(append([]byte{}, data...), '\n'),
	} {
		if err := os.WriteFile(path, damaged, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(dir, c.now); !errors.Is(err, ErrCorrupt) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestFailedWriteBreaksTheJournal(t *testing.T) {
	j := mustOpen(t, t.TempDir(), newClock())
	_ = j.chain.f.Close()
	if err := j.Accept(accepted(job1, "n1")); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("write to a closed file: %v", err)
	}
	if !errors.Is(j.Err(), ErrCorrupt) {
		t.Fatal("journal not marked broken")
	}
	if err := j.Reject(job2, "expired"); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("later write: %v", err)
	}
}

// reject journals a rejection as the agent does: statement first.
func reject(t *testing.T, j *Journal, id, reason string, delivered bool) {
	t.Helper()
	if err := j.Stated(id, testDigest, "rejected"); err != nil {
		t.Fatal(err)
	}
	if err := j.Reject(id, reason); err != nil {
		t.Fatal(err)
	}
	if delivered {
		if err := j.Delivered(id); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCompactionKeepsOpenJobsAndRecentOnes(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	j := mustOpen(t, dir, c)
	_ = j.Accept(accepted(job1, "n1"))
	_ = j.Start(job1) // in flight: always kept
	reject(t, j, job2, "expired", true)
	const pending = "job_01JB2Z6G8M4Q7R9T1V3W5X7Y04"
	reject(t, j, pending, "expired", false) // statement not delivered: always kept
	c.t = c.t.Add(Retention + time.Hour)
	reject(t, j, job3, "expired", true) // recent: kept
	if err := j.Compact(Retention, c.t); err != nil {
		t.Fatal(err)
	}
	if !j.Known(job1) || j.Known(job2) || !j.Known(job3) || !j.Known(pending) {
		t.Fatal("compaction kept the wrong jobs")
	}
	if p, _ := j.Position(pending); p.Digest != testDigest || p.State != KindRejected || p.Settled != "" {
		t.Fatalf("pending after compaction: %+v", p)
	}
	if err := j.Stated(job1, testDigest, "succeeded"); err != nil {
		t.Fatalf("append after compaction: %v", err)
	}
	if err := j.Complete(job1, "succeeded"); err != nil {
		t.Fatalf("append after compaction: %v", err)
	}
	_ = j.Close()
	j = mustOpen(t, dir, c)
	if j.State(job1) != KindCompleted || !j.Known(job3) || j.Known(job2) {
		t.Fatal("reopen after compaction")
	}
	if err := j.Compact(Retention, c.t); err != nil {
		t.Fatalf("second compaction: %v", err)
	}
}

// Review finding 2: a host clock moved far ahead does not let compaction
// forget a job; only the signed issuedAt of later jobs moves the cutoff.
func TestCompactionFollowsSignedTimeNotTheHostClock(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	issued := c.t
	j := mustOpen(t, dir, c)
	_ = j.Accept(accepted(job1, "n1"))
	_ = j.Start(job1)
	_ = j.Stated(job1, testDigest, "succeeded")
	_ = j.Complete(job1, "succeeded")
	_ = j.Delivered(job1)
	n, err := OpenNonces(dir, c.now)
	if err != nil {
		t.Fatal(err)
	}
	_ = n.Record("AAECAwQFBgcICQoLDA0ODw", job1)
	c.t = c.t.Add(91 * 24 * time.Hour)
	if err := j.Compact(Retention, issued); err != nil || !j.Known(job1) {
		t.Fatalf("forgot a job on the host clock alone: %v", err)
	}
	if err := n.Compact(issued); err != nil || !n.Seen("AAECAwQFBgcICQoLDA0ODw") {
		t.Fatalf("forgot a nonce on the host clock alone: %v", err)
	}
	if err := j.Compact(Retention, time.Time{}); err != nil || !j.Known(job1) {
		t.Fatal("compaction without any accepted job forgot something")
	}
	later := issued.Add(Retention + time.Hour)
	if err := j.Compact(Retention, later); err != nil || j.Known(job1) {
		t.Fatalf("a later signed job did not move the cutoff: %v", err)
	}
	if err := n.Compact(later); err != nil || n.Seen("AAECAwQFBgcICQoLDA0ODw") {
		t.Fatalf("nonce kept past the signed window: %v", err)
	}
}

func TestNonces(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	if err := Init(dir); err != nil {
		t.Fatal(err)
	}
	n, err := OpenNonces(dir, c.now)
	if err != nil {
		t.Fatal(err)
	}
	if n.Seen("AAECAwQFBgcICQoLDA0ODw") {
		t.Fatal("empty cache")
	}
	if err := n.Record("AAECAwQFBgcICQoLDA0ODw", job1); err != nil {
		t.Fatal(err)
	}
	if err := n.Record("AAECAwQFBgcICQoLDA0ODw", job2); err == nil {
		t.Fatal("recorded a nonce twice")
	}
	_ = n.Close()
	n, err = OpenNonces(dir, c.now)
	if err != nil || !n.Seen("AAECAwQFBgcICQoLDA0ODw") {
		t.Fatalf("reopen: %v", err)
	}
	c.t = c.t.Add(NonceWindow + time.Second)
	if !n.Seen("AAECAwQFBgcICQoLDA0ODw") {
		t.Fatal("forgot a nonce by reading the clock")
	}
	_ = n.Record("AQECAwQFBgcICQoLDA0ODw", job2)
	if err := n.Compact(c.t); err != nil || n.Len() != 1 || n.Seen("AAECAwQFBgcICQoLDA0ODw") {
		t.Fatalf("compaction: %v, %d", err, n.Len())
	}
	_ = n.Close()
	path := filepath.Join(dir, "nonces.log")
	data, _ := os.ReadFile(path)
	_ = os.WriteFile(path, bytes.Replace(data, []byte(job2), []byte(job3), 1), 0o600)
	if _, err := OpenNonces(dir, c.now); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("tampered cache: %v", err)
	}
}

// Review finding 5: jobs cut off by a crash are listed for the next start to
// settle, closed as interrupted once their statement is stated, reported for
// a week, and never more than the contract allows.
func TestCrashedJobsAreSettledAndReported(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	j := mustOpen(t, dir, c)
	for i := 0; i < MaxInFlightReported+1; i++ {
		id := fmt.Sprintf("job_01JB2Z6G8M4Q7R9T1V3W5X%04d", i)
		_ = j.Accept(accepted(id, fmt.Sprintf("n%d", i)))
		_ = j.Start(id)
		c.t = c.t.Add(time.Second)
	}
	_ = j.Accept(accepted(job1, "a1")) // accepted, never started
	_ = j.Close()
	j = mustOpen(t, dir, c)
	open := j.Unsettled()
	if len(open) != MaxInFlightReported+2 || open[len(open)-1].JobID != job1 || open[len(open)-1].State != KindAccepted ||
		open[0].State != KindStarted || open[0].Capability != "postgres.reload@1" || open[0].Digest != "" {
		t.Fatalf("unsettled %d: %+v", len(open), open[0])
	}
	for _, p := range open[:len(open)-1] {
		if err := j.Stated(p.JobID, testDigest, "failed"); err != nil {
			t.Fatal(err)
		}
		if err := j.Interrupt(p.JobID); err != nil {
			t.Fatal(err)
		}
	}
	if j.State("job_01JB2Z6G8M4Q7R9T1V3W5X0000") != KindInterrupted {
		t.Fatal("a started job was not closed as interrupted")
	}
	in := j.InFlight()
	if len(in) != MaxInFlightReported || in[0].JobID != "job_01JB2Z6G8M4Q7R9T1V3W5X0001" {
		t.Fatalf("reported %d in flight, first %v", len(in), in[0].JobID)
	}
	if err := j.Stated(job1, testDigest, "rejected"); err != nil {
		t.Fatal(err)
	}
	if err := j.Abandon(job1); err != nil {
		t.Fatal(err)
	}
	// Closed but not delivered: still to settle.
	if n := len(j.Unsettled()); n != MaxInFlightReported+2 {
		t.Fatalf("%d unsettled", n)
	}
	for _, p := range j.Unsettled() {
		if !p.Terminal() || p.Settled != "" {
			t.Fatalf("%+v", p)
		}
		if err := j.Delivered(p.JobID); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(j.Unsettled()); n != 0 {
		t.Fatalf("%d unsettled after delivery", n)
	}
	c.t = c.t.Add(InterruptedReported)
	if len(j.InFlight()) != 0 {
		t.Fatal("interrupted jobs reported past the window")
	}
}

// A job whose statement is stated but whose completion record a crash cut
// off is still open (in flight, unsettled) until the next start completes
// it from that statement.
func TestAStatedJobStaysOpenUntilItIsClosed(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	j := mustOpen(t, dir, c)
	for _, id := range []string{job1, job2} {
		_ = j.Accept(accepted(id, "n"+id[len(id)-2:]))
		_ = j.Start(id)
	}
	_ = j.Stated(job1, testDigest, "succeeded")
	_ = j.Close()
	j = mustOpen(t, dir, c)
	open := j.Unsettled()
	if len(open) != 2 || open[0].JobID != job1 || open[0].Digest != testDigest || open[0].Outcome != "succeeded" ||
		open[0].Terminal() || open[1].Digest != "" {
		t.Fatalf("%+v", open)
	}
	if in := j.InFlight(); len(in) != 2 {
		t.Fatalf("%v", in)
	}
	if err := j.Interrupt(job1); !errors.Is(err, ErrState) {
		t.Fatalf("interrupted although it states success: %v", err)
	}
	if err := j.Complete(job1, "succeeded"); err != nil {
		t.Fatal(err)
	}
	if j.State(job1) != KindCompleted {
		t.Fatal(j.State(job1))
	}
	if in := j.InFlight(); len(in) != 1 || in[0].JobID != job2 {
		t.Fatalf("%v", in)
	}
}

// Review finding 12: the status command reads a live journal without cutting
// a torn tail the running agent may still be writing.
func TestReadOnlyOpenNeverChangesTheFile(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	j := mustOpen(t, dir, c)
	_ = j.Accept(accepted(job1, "n1"))
	_ = j.Close()
	path := filepath.Join(dir, "journal.log")
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString(`{"partial":`)
	_ = f.Close()
	before, _ := os.ReadFile(path)
	r, err := OpenReadOnly(dir, c.now)
	if err != nil || !r.Known(job1) {
		t.Fatalf("read-only open: %v", err)
	}
	if err := r.Start(job1); err == nil {
		t.Fatal("a read-only journal accepted a write")
	}
	_ = r.Close()
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("a read-only open changed the file")
	}
	if _, err := OpenReadOnly(t.TempDir(), c.now); err == nil {
		t.Fatal("a read-only open created a journal")
	}
	j = mustOpen(t, dir, c) // the writer cuts the torn tail
	info, _ := os.Stat(path)
	if j.Stats().Bytes != info.Size() {
		t.Fatalf("size after the cut: %d, file %d", j.Stats().Bytes, info.Size())
	}
	if err := j.Start(job1); err != nil {
		t.Fatal(err)
	}
}

// Review finding 8: a full journal refuses a record but stays intact.
func TestFullJournalRefusesWithoutBreaking(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	j := mustOpen(t, dir, c)
	_ = j.Accept(accepted(job1, "n1"))
	defer func(old int64) { maxFileBytes = old }(maxFileBytes)
	maxFileBytes = j.Stats().Bytes + 10
	if err := j.Accept(accepted(job2, "n2")); !errors.Is(err, ErrFull) {
		t.Fatalf("full journal: %v", err)
	}
	if j.Err() != nil || j.Known(job2) {
		t.Fatal("a refused record broke the journal or was kept")
	}
	maxFileBytes = 1 << 20
	if err := j.Accept(accepted(job2, "n2")); err != nil {
		t.Fatal(err)
	}
}

// FuzzOpen: any file content either opens (and then accepts a new record that
// survives a reopen) or is refused as corrupt; it never panics.
func FuzzOpen(f *testing.F) {
	dir, c := f.TempDir(), newClock()
	_ = Init(dir)
	j, _ := Open(dir, c.now)
	_ = j.Accept(accepted(job1, "n1"))
	_ = j.Start(job1)
	_ = j.Stated(job1, testDigest, "succeeded")
	_ = j.Complete(job1, "succeeded")
	_ = j.Delivered(job1)
	_ = j.Accept(accepted(job2, "n2"))
	_ = j.Start(job2)
	_ = j.Close()
	seed, _ := os.ReadFile(filepath.Join(dir, "journal.log"))
	f.Add(seed)
	f.Add([]byte{})
	f.Add([]byte("{}\n"))
	f.Add(seed[:len(seed)/2])
	if format1, err := os.ReadFile(filepath.Join("..", "agent", "testdata", "journal-format1", "journal.log")); err == nil {
		f.Add(format1)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "journal.log"), data, 0o600); err != nil {
			t.Fatal(err)
		}
		j, err := Open(dir, c.now)
		if err != nil {
			if !errors.Is(err, ErrCorrupt) {
				t.Fatalf("unexpected error: %v", err)
			}
			return
		}
		if err := j.Stated(job3, testDigest, "rejected"); err != nil && !errors.Is(err, ErrState) {
			t.Fatal(err)
		}
		if err := j.Reject(job3, "expired"); err != nil && !errors.Is(err, ErrState) {
			t.Fatal(err)
		}
		_ = j.Close()
		if _, err := Open(dir, c.now); err != nil {
			t.Fatalf("reopen after append: %v", err)
		}
	})
}

func TestLedgerRecordsEffectsDurably(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	l, err := OpenLedger(dir, "effects.log", c.now)
	if err != nil {
		t.Fatal(err)
	}
	issued := c.t.Add(-time.Minute)
	effect := func(id, op string) Effect {
		return Effect{JobID: id, Op: op, IssuedAt: issued, ExpiresAt: issued.Add(time.Hour)}
	}
	if err := l.Record(effect(job1, "hba.write")); err != nil {
		t.Fatal(err)
	}
	_ = l.Record(effect(job1, "hba.restore"))
	_ = l.Close()
	l, err = OpenLedger(dir, "effects.log", c.now)
	if err != nil {
		t.Fatal(err)
	}
	if ops := l.Ops(job1); len(ops) != 2 || ops[0] != "hba.write" || ops[1] != "hba.restore" {
		t.Fatalf("ops %v", ops)
	}
	if len(l.Ops(job2)) != 0 {
		t.Fatal("unknown job has effects")
	}
	if !l.HighestIssuedAt().Equal(issued) {
		t.Fatalf("highest issuedAt %v", l.HighestIssuedAt())
	}
	_ = l.Close()
	path := filepath.Join(dir, "effects.log")
	data, _ := os.ReadFile(path)
	_ = os.WriteFile(path, bytes.Replace(data, []byte("hba.write"), []byte("hba.wrote"), 1), 0o600)
	if _, err := OpenLedger(dir, "effects.log", c.now); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("tampered ledger: %v", err)
	}
}

func TestLedgerCompactionFollowsSignedTime(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	l, err := OpenLedger(dir, "effects.log", c.now)
	if err != nil {
		t.Fatal(err)
	}
	old := c.t.Add(-10 * 24 * time.Hour)
	_ = l.Record(Effect{JobID: job1, Op: "service.restart", IssuedAt: old, ExpiresAt: old.Add(time.Hour)})
	// A clock set far forward does not drop a record: the cutoff follows
	// the highest signed issuedAt.
	c.t = c.t.Add(365 * 24 * time.Hour)
	if err := l.Compact(7 * 24 * time.Hour); err != nil {
		t.Fatal(err)
	}
	if len(l.Ops(job1)) != 1 {
		t.Fatal("a clock set forward dropped an effect")
	}
	c.t = c.t.Add(-365 * 24 * time.Hour)
	recent := c.t.Add(-time.Minute)
	_ = l.Record(Effect{JobID: job2, Op: "hba.write", IssuedAt: recent, ExpiresAt: recent.Add(time.Hour)})
	if err := l.Compact(7 * 24 * time.Hour); err != nil {
		t.Fatal(err)
	}
	if len(l.Ops(job1)) != 0 || len(l.Ops(job2)) != 1 {
		t.Fatalf("compaction kept %v and %v", l.Ops(job1), l.Ops(job2))
	}
	_ = l.Close()
	l, err = OpenLedger(dir, "effects.log", c.now)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if len(l.Ops(job1)) != 0 || len(l.Ops(job2)) != 1 || !l.HighestIssuedAt().Equal(recent) {
		t.Fatal("the compacted ledger does not replay")
	}
}

// TestLedgerErrAndCompactRunTogether: the daily compaction and the helper's
// requests share the ledger (run with -race; Phase 4 review).
func TestLedgerErrAndCompactRunTogether(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	l, err := OpenLedger(dir, "effects.log", c.now)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	old := c.t.Add(-30 * 24 * time.Hour)
	_ = l.Record(Effect{JobID: job1, Op: "hba.write", IssuedAt: old, ExpiresAt: old.Add(time.Hour)})
	recent := c.t.Add(-time.Minute)
	_ = l.Record(Effect{JobID: job2, Op: "hba.write", IssuedAt: recent, ExpiresAt: recent.Add(time.Hour)})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 50; i++ {
			_ = l.Err()
			_ = l.Ops(job2)
		}
	}()
	if err := l.Compact(7 * 24 * time.Hour); err != nil {
		t.Fatal(err)
	}
	<-done
	if l.Err() != nil || len(l.Ops(job2)) != 1 {
		t.Fatal("the ledger did not survive compaction")
	}
}

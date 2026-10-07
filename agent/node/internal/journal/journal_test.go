package journal

import (
	"bytes"
	"errors"
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

func mustOpen(t *testing.T, dir string, c *testClock) *Journal {
	t.Helper()
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
		func() error { return j.Complete(job2, "succeeded") },
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
	if err := j.Abandon(job1); err != nil {
		t.Fatal(err)
	}
	if err := j.Start(job1); !errors.Is(err, ErrState) {
		t.Fatalf("start after abandon: %v", err)
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

func TestCompactionKeepsOpenJobsAndRecentOnes(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	j := mustOpen(t, dir, c)
	_ = j.Accept(accepted(job1, "n1"))
	_ = j.Start(job1) // in flight: always kept
	_ = j.Reject(job2, "expired")
	c.t = c.t.Add(Retention + time.Hour)
	_ = j.Reject(job3, "expired") // recent: kept
	if err := j.Compact(Retention); err != nil {
		t.Fatal(err)
	}
	if !j.Known(job1) || j.Known(job2) || !j.Known(job3) {
		t.Fatal("compaction kept the wrong jobs")
	}
	if err := j.Complete(job1, "succeeded"); err != nil {
		t.Fatalf("append after compaction: %v", err)
	}
	_ = j.Close()
	j = mustOpen(t, dir, c)
	if j.State(job1) != KindCompleted || !j.Known(job3) || j.Known(job2) {
		t.Fatal("reopen after compaction")
	}
	if err := j.Compact(Retention); err != nil {
		t.Fatalf("second compaction: %v", err)
	}
}

func TestNonces(t *testing.T) {
	dir, c := t.TempDir(), newClock()
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
	if n.Seen("AAECAwQFBgcICQoLDA0ODw") {
		t.Fatal("remembered past the window")
	}
	_ = n.Record("AQECAwQFBgcICQoLDA0ODw", job2)
	if err := n.Compact(); err != nil || n.Len() != 1 {
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

// FuzzOpen: any file content either opens (and then accepts a new record that
// survives a reopen) or is refused as corrupt; it never panics.
func FuzzOpen(f *testing.F) {
	dir, c := f.TempDir(), newClock()
	j, _ := Open(dir, c.now)
	_ = j.Accept(accepted(job1, "n1"))
	_ = j.Start(job1)
	_ = j.Close()
	seed, _ := os.ReadFile(filepath.Join(dir, "journal.log"))
	f.Add(seed)
	f.Add([]byte{})
	f.Add([]byte("{}\n"))
	f.Add(seed[:len(seed)/2])
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
		if err := j.Reject(job3, "expired"); err != nil && !errors.Is(err, ErrState) {
			t.Fatal(err)
		}
		_ = j.Close()
		if _, err := Open(dir, c.now); err != nil {
			t.Fatalf("reopen after append: %v", err)
		}
	})
}

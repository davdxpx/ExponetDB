package journal

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Review finding F7 (replay state): a missing replay file is never created
// on open. Before F7 the agent and the helper recreated a lost journal,
// nonce cache or effect ledger silently, so an envelope could run twice.
func TestAMissingReplayFileIsNeverCreatedOnOpen(t *testing.T) {
	c := newClock()
	opens := map[string]func(dir string) error{
		"journal.log": func(dir string) error { _, err := Open(dir, c.now); return err },
		"nonces.log":  func(dir string) error { _, err := OpenNonces(dir, c.now); return err },
		"effects.log": func(dir string) error { _, err := OpenExistingLedger(dir, "effects.log", c.now); return err },
	}
	for name, open := range opens {
		dir := t.TempDir()
		if err := open(dir); !errors.Is(err, ErrMissing) || !errors.Is(err, ErrCorrupt) {
			t.Errorf("%s: a missing file opened: %v", name, err)
		}
		if _, err := os.Stat(filepath.Join(dir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s was created on open: %v", name, err)
		}
	}
}

// A ledger that held an effect and was then lost is refused, never
// recreated empty (which would let the job have its effect again).
func TestALostLedgerIsRefused(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	l := mustLedger(t, dir, c)
	issued := c.t.Add(-time.Minute)
	if err := l.Record(Effect{JobID: job1, Op: "hba.write", IssuedAt: issued, ExpiresAt: issued.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	_ = l.Close()
	if err := os.Remove(filepath.Join(dir, "effects.log")); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenExistingLedger(dir, "effects.log", c.now); !errors.Is(err, ErrMissing) {
		t.Fatalf("a lost ledger opened: %v", err)
	}
	lost := BrokenLedger(dir, "effects.log", ErrMissing, c.now)
	if err := lost.Record(Effect{JobID: job2, Op: "hba.write", IssuedAt: issued, ExpiresAt: issued.Add(time.Hour)}); !errors.Is(err, ErrMissing) || lost.Err() == nil {
		t.Fatalf("a lost ledger recorded an effect: %v", err)
	}
	if err := lost.Compact(7 * 24 * time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "effects.log")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a lost ledger was recreated: %v", err)
	}
}

func mustLedger(t *testing.T, dir string, c *testClock) *Ledger {
	t.Helper()
	if err := InitLedger(dir, "effects.log"); err != nil {
		t.Fatal(err)
	}
	l, err := OpenExistingLedger(dir, "effects.log", c.now)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

// Initialization is durable: each file is created empty, owner-only, and its
// directory is synced after it appears; a second initialization leaves the
// files as they are, and InitLedger refuses an existing ledger.
func TestInitializationIsDurable(t *testing.T) {
	dir := t.TempDir()
	var synced []string
	defer func(old func(string) error) { syncDir = old }(syncDir)
	syncDir = func(d string) error {
		entries, _ := os.ReadDir(d)
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		synced = append(synced, d+":"+strings.Join(names, ","))
		return nil
	}
	if present, err := Present(dir); err != nil || len(present) != 0 {
		t.Fatalf("present %v %v", present, err)
	}
	if err := Init(dir); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(synced, []string{dir + ":journal.log", dir + ":journal.log,nonces.log"}) {
		t.Fatalf("directory syncs %v", synced)
	}
	for _, name := range []string{"journal.log", "nonces.log"} {
		info, err := os.Lstat(filepath.Join(dir, name))
		if err != nil || info.Size() != 0 || info.Mode().Perm() != 0o600 || !info.Mode().IsRegular() {
			t.Fatalf("%s: %v %v", name, info, err)
		}
	}
	if present, err := Present(dir); err != nil || !slices.Equal(present, []string{"journal.log", "nonces.log"}) {
		t.Fatalf("present %v %v", present, err)
	}
	c := newClock()
	j, err := Open(dir, c.now)
	if err != nil {
		t.Fatal(err)
	}
	_ = j.Accept(accepted(job1, "n1"))
	_ = j.Close()
	before, _ := os.ReadFile(filepath.Join(dir, "journal.log"))
	if err := Init(dir); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(filepath.Join(dir, "journal.log")); !bytes.Equal(before, after) {
		t.Fatal("a second initialization changed the journal")
	}
	if err := InitLedger(dir, "effects.log"); err != nil {
		t.Fatal(err)
	}
	if err := InitLedger(dir, "effects.log"); !errors.Is(err, ErrExists) {
		t.Fatalf("a second ledger initialization: %v", err)
	}
	// A failed directory sync fails the initialization.
	syncDir = func(string) error { return errors.New("injected sync failure") }
	if err := Init(t.TempDir()); err == nil {
		t.Fatal("an initialization whose directory sync failed succeeded")
	}
	// A symbolic link in a replay file's place is never followed.
	other := t.TempDir()
	if err := os.Symlink(filepath.Join(other, "target"), filepath.Join(other, "journal.log")); err != nil {
		t.Fatal(err)
	}
	syncDir = func(string) error { return nil }
	if err := Init(other); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(other, "target")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("initialization wrote through a symbolic link")
	}
	if _, err := Open(other, c.now); err == nil {
		t.Fatal("a symbolic link opened as the journal")
	}
}

// Compaction replaces a replay file in one step: the file is never missing,
// no other file stays behind, and a file that cannot be read back breaks the
// journal while it keeps every job it knew (never "nothing is known").
func TestCompactionNeverLeavesTheFileMissing(t *testing.T) {
	dir, c := t.TempDir(), newClock()
	j := mustOpen(t, dir, c)
	_ = j.Accept(accepted(job1, "n1"))
	_ = j.Start(job1)
	_ = j.Reject(job2, "expired")
	c.t = c.t.Add(Retention + time.Hour)
	if err := j.Compact(Retention, c.t); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if !slices.Equal(names, []string{"journal.log", "nonces.log"}) {
		t.Fatalf("after compaction: %v", names)
	}
	// A rewrite that cannot replace the file (a directory in its place makes
	// rename(2) fail) breaks the journal, which keeps every job it knew.
	path := filepath.Join(dir, "journal.log")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(path, "occupied"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := j.Compact(Retention, c.t); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("a compaction that could not replace the file: %v", err)
	}
	if !j.Known(job1) || !errors.Is(j.Err(), ErrCorrupt) {
		t.Fatal("a failed compaction forgot the journal or did not break it")
	}
	if err := j.Accept(accepted(job3, "n3")); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("a write after a failed compaction: %v", err)
	}
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		t.Fatalf("the failed compaction replaced the path: %v", err)
	}
	if err := os.RemoveAll(path); err != nil {
		t.Fatal(err)
	}
}

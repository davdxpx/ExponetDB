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

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
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
	reject(t, j, job2, "expired", true)
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

// A format-1 journal (testdata of the agent, written by the previous
// release) replays: its terminal jobs are settled as they are, its open jobs
// are listed to settle, and new records append to it.
func TestAFormat1JournalReplays(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "agent", "testdata", "journal-format1", "journal.log"))
	if err != nil {
		t.Fatal(err)
	}
	dir, c := t.TempDir(), newClock()
	if err := os.WriteFile(filepath.Join(dir, "journal.log"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	j, err := Open(dir, c.now)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	var ids []string
	for _, p := range j.Unsettled() {
		ids = append(ids, p.JobID+":"+p.State)
	}
	if !slices.Equal(ids, []string{
		"job_01JB2Z6G8M4Q7R9T1V3W5X7Y16:step", "job_01JB2Z6G8M4Q7R9T1V3W5X7Y17:step", "job_01JB2Z6G8M4Q7R9T1V3W5X7Y18:accepted",
	}) {
		t.Fatalf("unsettled %v", ids)
	}
	if p, _ := j.Position("job_01JB2Z6G8M4Q7R9T1V3W5X7Y12"); p.State != KindCompleted || p.Digest != "" || !p.Terminal() {
		t.Fatalf("%+v", p)
	}
	// A format-1 terminal job takes no format-2 record.
	if err := j.Delivered("job_01JB2Z6G8M4Q7R9T1V3W5X7Y12"); !errors.Is(err, ErrState) {
		t.Fatalf("delivered after a format-1 completion: %v", err)
	}
	// Its open jobs are settled with format-2 records.
	if err := j.Stated("job_01JB2Z6G8M4Q7R9T1V3W5X7Y18", testDigest, "rejected"); err != nil {
		t.Fatal(err)
	}
	if err := j.Abandon("job_01JB2Z6G8M4Q7R9T1V3W5X7Y18"); err != nil {
		t.Fatal(err)
	}
}

// Replay refuses a format-2 record that does not fit: a stated record
// without a digest, a terminal record that contradicts its statement, a
// delivered record before the terminal record, and an unknown kind (what a
// format-1 reader does with every format-2 record: journal_corrupt).
func TestReplayRefusesRecordsThatDoNotFit(t *testing.T) {
	c := newClock()
	write := func(t *testing.T, records ...canon.Object) string {
		dir := t.TempDir()
		ch := &chain{last: genesis}
		var buf bytes.Buffer
		for _, r := range records {
			seq := ch.seq + 1
			full := append(canon.Object{{Name: "seq", Value: canon.Number(seq)}, {Name: "prev", Value: canon.String(ch.last)}}, r...)
			hash, _ := recordHash(full)
			line, _ := canon.Canonicalize(append(full, canon.Member{Name: "hash", Value: canon.String(hash)}))
			buf.Write(line)
			buf.WriteByte('\n')
			ch.seq, ch.last = seq, hash
		}
		if err := os.WriteFile(filepath.Join(dir, "journal.log"), buf.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	rec := func(kind string, more ...canon.Member) canon.Object {
		return append(canon.Object{
			{Name: "kind", Value: canon.String(kind)},
			{Name: "jobId", Value: canon.String(job1)},
			{Name: "at", Value: canon.String("2026-10-07T12:00:00Z")},
		}, more...)
	}
	digest := canon.Member{Name: "digest", Value: canon.String(testDigest)}
	for name, records := range map[string][]canon.Object{
		"stated without digest":  {rec(KindStated, canon.Member{Name: "outcome", Value: canon.String("rejected")})},
		"stated without outcome": {rec(KindStated, digest)},
		"contradicting completion": {rec(KindAccepted), rec(KindStarted),
			rec(KindStated, digest, canon.Member{Name: "outcome", Value: canon.String("failed")}),
			rec(KindCompleted, canon.Member{Name: "outcome", Value: canon.String("succeeded")})},
		"delivered before terminal": {rec(KindStated, digest, canon.Member{Name: "outcome", Value: canon.String("rejected")}),
			rec(KindDelivered)},
		"step after statement": {rec(KindAccepted), rec(KindStarted),
			rec(KindStated, digest, canon.Member{Name: "outcome", Value: canon.String("failed")}), rec(KindStep)},
		"unknown kind": {rec("resumed")},
	} {
		if _, err := Open(write(t, records...), c.now); !errors.Is(err, ErrCorrupt) {
			t.Errorf("%s: %v", name, err)
		}
	}
	ok := []canon.Object{rec(KindStated, digest, canon.Member{Name: "outcome", Value: canon.String("rejected")}),
		rec(KindRejected, canon.Member{Name: "reason", Value: canon.String("expired")}), rec(KindParked)}
	j, err := Open(write(t, ok...), c.now)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	if p, _ := j.Position(job1); p.Settled != KindParked || p.State != KindRejected || len(j.Unsettled()) != 0 {
		t.Fatalf("%+v", p)
	}
}

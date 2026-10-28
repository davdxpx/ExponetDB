package journal

// Block R, tester R3, TC-070 (GAP-07): the helper's effect ledger on a filesystem that fills up.
// Needs a tmpfs of two pages: R3_TMPFS=/mnt/r3-tmpfs (mount -t tmpfs -o size=8k tmpfs /mnt/r3-tmpfs).
// Copy to agent/node/internal/journal/r3_ledger_diskfull_test.go and run
// `R3_TMPFS=... go test -count=1 -run TestR3 -v ./internal/journal`.

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestR3LedgerDiskFull(t *testing.T) {
	dir := os.Getenv("R3_TMPFS")
	if dir == "" {
		t.Skip("R3_TMPFS not set")
	}
	_ = os.Remove(filepath.Join(dir, "effects.log"))
	now := time.Now()
	if err := InitLedger(dir, "effects.log"); err != nil {
		t.Fatal(err)
	}
	l, err := OpenLedger(dir, "effects.log", time.Now)
	if err != nil {
		t.Fatal(err)
	}
	// A filler page, removed later to free space.
	filler := filepath.Join(dir, "filler")
	_ = os.WriteFile(filler, make([]byte, 4096), 0o600)
	var failedAt int
	var firstErr error
	for i := 0; i < 100; i++ {
		e := l.Record(Effect{JobID: fmt.Sprintf("job%04d", i), Op: "hba.apply", IssuedAt: now, ExpiresAt: now.Add(time.Hour)})
		if e != nil {
			failedAt, firstErr = i, e
			break
		}
	}
	st, _ := os.Stat(filepath.Join(dir, "effects.log"))
	t.Logf("first failing record: %d, error: %v; file size after failure: %d bytes", failedAt, firstErr, st.Size())
	// Free the space and try again: does the same open ledger accept an effect?
	_ = os.Remove(filler)
	e2 := l.Record(Effect{JobID: "job-after-free", Op: "hba.apply", IssuedAt: now, ExpiresAt: now.Add(time.Hour)})
	t.Logf("record after freeing space (same process, no restart): err=%v", e2)
	st2, _ := os.Stat(filepath.Join(dir, "effects.log"))
	t.Logf("file size after the second attempt: %d bytes", st2.Size())
	_ = l.Close()
	// A restart (a new open) replays and drops the torn tail.
	l2, err := OpenLedger(dir, "effects.log", time.Now)
	t.Logf("reopen (restart): err=%v", err)
	if err == nil {
		e3 := l2.Record(Effect{JobID: "job-after-restart", Op: "hba.apply", IssuedAt: now, ExpiresAt: now.Add(time.Hour)})
		st3, _ := os.Stat(filepath.Join(dir, "effects.log"))
		t.Logf("record after restart: err=%v; file size %d bytes", e3, st3.Size())
		_ = l2.Close()
	}
}

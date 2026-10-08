package helper

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
)

// Review finding F7 (replay state): the helper initializes its effect ledger
// once, durably, and records that beside its trust; a ledger lost after that
// is never recreated: every effect is refused, reads are still served.
func TestALostLedgerRefusesEveryEffect(t *testing.T) {
	e := newEnv(t)
	stateDir := filepath.Join(e.root, "helper-state")
	if err := os.Mkdir(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	ledgerPath := filepath.Join(stateDir, LedgerFile)
	record := LedgerRecordPath(e.h.TrustPath)

	// First start: initialized, then recorded.
	l, err := OpenLedger(stateDir, e.h.TrustPath, os.Geteuid(), e.clk.Now)
	if err != nil {
		t.Fatal(err)
	}
	var r LedgerRecord
	data, err := os.ReadFile(record)
	if err != nil || json.Unmarshal(data, &r) != nil || r.Schema != LedgerRecordSchema || r.Ledger != ledgerPath {
		t.Fatalf("record %s: %v", data, err)
	}
	e.h.Ledger = l
	e.mustCall(OpServiceRestart, e.job("postgres.restart", restartArgs()))
	_ = l.Close()
	// A second start opens the same ledger.
	if l, err = OpenLedger(stateDir, e.h.TrustPath, os.Geteuid(), e.clk.Now); err != nil || len(l.Ops("job_01JB2Z6G8M4Q7R9T1V3W5X7Y01")) != 1 {
		t.Fatalf("reopen: %v", err)
	}
	_ = l.Close()

	if err := os.Remove(ledgerPath); err != nil {
		t.Fatal(err)
	}
	lost, err := OpenLedger(stateDir, e.h.TrustPath, os.Geteuid(), e.clk.Now)
	if !errors.Is(err, ErrLedgerLost) || lost == nil || lost.Err() == nil {
		t.Fatalf("a lost ledger opened: %v", err)
	}
	if _, err := os.Stat(ledgerPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a lost ledger was recreated: %v", err)
	}
	e.h.Ledger = lost
	calls := len(e.runner.calls)
	e.mustRefuse(OpServiceRestart, e.job("postgres.restart", restartArgs()), CodeFailed)
	if len(e.runner.calls) != calls {
		t.Fatal("an effect ran without a ledger")
	}
	if keys := e.mustCall(OpTrustInspect, e.job("agent.diagnostics", canon.Object{})); len(keys) == 0 {
		t.Fatal("a read was refused")
	}

	// ledger init: never over an existing ledger; for a missing one only by
	// the operator.
	if err := InitLedger(stateDir, e.h.TrustPath, e.clk.Now); err != nil {
		t.Fatal(err)
	}
	if err := InitLedger(stateDir, e.h.TrustPath, e.clk.Now); !errors.Is(err, journal.ErrExists) {
		t.Fatalf("a second init: %v", err)
	}
}

// A ledger of the previous release (created on open, no record) keeps
// working and gets its record; a record in a directory others can write is
// refused.
func TestALedgerWithoutItsRecordIsAdopted(t *testing.T) {
	e := newEnv(t)
	stateDir := filepath.Join(e.root, "state")
	record := LedgerRecordPath(e.h.TrustPath)
	if _, err := os.Stat(record); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("record before the first open: %v", err)
	}
	e.mustCall(OpServiceRestart, e.job("postgres.restart", restartArgs()))
	_ = e.h.Ledger.Close()
	l, err := OpenLedger(stateDir, e.h.TrustPath, os.Geteuid(), e.clk.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if len(l.Ops("job_01JB2Z6G8M4Q7R9T1V3W5X7Y01")) != 1 {
		t.Fatal("the existing ledger was not opened")
	}
	if data, err := os.ReadFile(record); err != nil || !strings.Contains(string(data), LedgerRecordSchema) {
		t.Fatalf("record %s: %v", data, err)
	}
	open := filepath.Join(e.root, "open")
	if err := os.Mkdir(open, 0o777); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(open, 0o777)
	if _, err := OpenLedger(stateDir, filepath.Join(open, "trust.json"), os.Geteuid(), e.clk.Now); err == nil {
		t.Fatal("a record in a directory others can write was used")
	}
}

package helper

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/fsutil"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
)

// LedgerFile is the effect ledger in the helper's state directory.
const LedgerFile = "effects.log"

// LedgerRecordFile records, beside the trust file (root-owned, outside the
// state directory), that the effect ledger was initialized; LedgerRecordSchema
// versions it.
const (
	LedgerRecordFile   = "helper-ledger.json"
	LedgerRecordSchema = "exponetdb.helper-ledger/v1"
)

// LedgerRecord says where the helper's effect ledger was initialized and
// when. From then on a missing ledger is lost, never created again.
type LedgerRecord struct {
	Schema        string `json:"schema"`
	Ledger        string `json:"ledger"`
	InitializedAt string `json:"initializedAt"`
}

// ErrLedgerLost: the initialization record exists and the ledger does not.
var ErrLedgerLost = errors.New("the effect ledger is lost")

// LedgerRecordPath is the initialization record that belongs to a trust file.
func LedgerRecordPath(trustPath string) string {
	return filepath.Join(filepath.Dir(trustPath), LedgerRecordFile)
}

// OpenLedger opens the effect ledger in stateDir by the initialization rule
// (architecture.md §2, item 5):
//
//   - the ledger exists: it is opened; a missing initialization record (a
//     helper of the previous release, which created its ledger on open) is
//     written;
//   - neither exists: the ledger was never initialized (a new helper, or one
//     of the previous release that never served), so it never held an
//     effect: it is created durably, then the record is written;
//   - the record exists and the ledger does not: the ledger is lost. The
//     returned ledger refuses every effect (read-only operations are still
//     served) and err is ErrLedgerLost; nothing is created.
//
// The record lives in the trust file's directory, which only ownerUID (root)
// can write, so losing the state directory is never mistaken for a first
// start.
func OpenLedger(stateDir, trustPath string, ownerUID int, now func() time.Time) (*journal.Ledger, error) {
	record := LedgerRecordPath(trustPath)
	if err := fsutil.CheckParent(record, ownerUID); err != nil {
		return nil, fmt.Errorf("ledger record: %w", err)
	}
	ledgerPath := filepath.Join(stateDir, LedgerFile)
	_, ledgerErr := os.Lstat(ledgerPath)
	_, recordErr := os.Lstat(record)
	switch {
	case ledgerErr != nil && !errors.Is(ledgerErr, os.ErrNotExist):
		return nil, ledgerErr
	case recordErr != nil && !errors.Is(recordErr, os.ErrNotExist):
		return nil, recordErr
	case ledgerErr == nil:
		l, err := journal.OpenExistingLedger(stateDir, LedgerFile, now)
		if err != nil {
			return nil, err
		}
		if recordErr != nil {
			if err := writeLedgerRecord(ledgerPath, record, now); err != nil {
				_ = l.Close()
				return nil, err
			}
		}
		return l, nil
	case recordErr == nil:
		err := fmt.Errorf("%w: %s is missing while %s records its initialization; every effect is refused, nothing is recreated (node-runbook.md)",
			ErrLedgerLost, ledgerPath, record)
		return journal.BrokenLedger(stateDir, LedgerFile, err, now), err
	}
	if err := InitLedger(stateDir, trustPath, now); err != nil {
		return nil, err
	}
	return journal.OpenExistingLedger(stateDir, LedgerFile, now)
}

// InitLedger creates the empty ledger in stateDir durably, then its
// initialization record; it refuses an existing ledger (journal.ErrExists)
// and changes nothing then.
func InitLedger(stateDir, trustPath string, now func() time.Time) error {
	if err := journal.InitLedger(stateDir, LedgerFile); err != nil {
		return err
	}
	return writeLedgerRecord(filepath.Join(stateDir, LedgerFile), LedgerRecordPath(trustPath), now)
}

func writeLedgerRecord(ledgerPath, record string, now func() time.Time) error {
	abs, err := filepath.Abs(ledgerPath)
	if err != nil {
		return err
	}
	data, err := json.Marshal(LedgerRecord{Schema: LedgerRecordSchema, Ledger: abs, InitializedAt: now().UTC().Format(time.RFC3339)})
	if err != nil {
		return err
	}
	return fsutil.WriteAtomic(record, append(data, '\n'), 0o600)
}

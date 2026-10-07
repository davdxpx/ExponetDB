package clock

import (
	"errors"
	"testing"
	"time"
)

func TestCheck(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		name    string
		synced  bool
		highest time.Time
		ok      bool
	}{
		{"synchronized, nothing accepted yet", true, time.Time{}, true},
		{"not synchronized", false, time.Time{}, false},
		{"within tolerance of the latest issuedAt", true, now.Add(29 * time.Second), true},
		{"rollback beyond tolerance", true, now.Add(31 * time.Second), false},
		{"latest issuedAt in the past", true, now.Add(-time.Hour), true},
	} {
		err := Check(&Fixed{T: now, Synced: c.synced}, c.highest)
		if (err == nil) != c.ok || (err != nil && !errors.Is(err, ErrUntrusted)) {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}

func TestSystemSynchronizedIsReadOnly(t *testing.T) {
	// The call must work unprivileged and change nothing; its answer depends
	// on the host.
	if _, err := (System{}).Synchronized(); err != nil {
		t.Fatalf("adjtimex: %v", err)
	}
}

// Review finding 13: systemd's rule, the maximum error alone.
func TestSyncedFollowsSystemd(t *testing.T) {
	for _, c := range []struct {
		maxError int64
		ok       bool
	}{{0, true}, {500_000, true}, {15_999_999, true}, {16_000_000, false}, {16_000_001, false}} {
		if synced(c.maxError) != c.ok {
			t.Errorf("maxerror %d µs: synced %v", c.maxError, !c.ok)
		}
	}
}

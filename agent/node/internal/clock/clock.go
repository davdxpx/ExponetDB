// Package clock is the agent's trusted-clock rule (ADR-0024 §5, protocol.md
// §4.2 step 3): the agent trusts its host clock only while the kernel reports
// it synchronized, and never while it is earlier than the latest accepted
// issuedAt by more than the skew tolerance (a rollback). The gateway's
// serverTime is advisory and never consulted here.
package clock

import (
	"errors"
	"syscall"
	"time"
)

// Tolerance is the accepted skew (protocol.md §4.2 step 3).
const Tolerance = 30 * time.Second

// Clock is the host clock as the agent sees it.
type Clock interface {
	Now() time.Time
	// Synchronized reports whether the host clock is synchronized (NTP).
	Synchronized() (bool, error)
}

// System is the real host clock. Synchronized asks the kernel with a
// read-only adjtimex call and applies systemd's rule for NTPSynchronized
// (ntp_synced(): the kernel's maximum error estimate is below 16 s; the
// STA_UNSYNC bit is ignored, because chrony and others keep it set to stop
// the kernel from writing the RTC while the clock is synchronized).
type System struct{}

// maxErrorMicros is the kernel's "unsynchronized" maximum error (16 s,
// NTP_PHASE_LIMIT), which it reaches when no time daemon updates it.
const maxErrorMicros = 16_000_000

// Now returns the current time.
func (System) Now() time.Time { return time.Now() }

// Synchronized reads the kernel's clock state without changing it.
func (System) Synchronized() (bool, error) {
	var tx syscall.Timex // Modes 0: read only
	if _, err := syscall.Adjtimex(&tx); err != nil {
		return false, err
	}
	return synced(int64(tx.Maxerror)), nil
}

func synced(maxError int64) bool { return maxError < maxErrorMicros }

// ErrUntrusted is returned by Check when the clock may not be used.
var ErrUntrusted = errors.New("clock_untrusted")

// Check returns ErrUntrusted unless the clock is synchronized and not earlier
// than highestIssuedAt minus Tolerance. A zero highestIssuedAt means no job
// was accepted yet.
func Check(c Clock, highestIssuedAt time.Time) error {
	ok, err := c.Synchronized()
	if err != nil || !ok {
		return ErrUntrusted
	}
	if !highestIssuedAt.IsZero() && c.Now().Before(highestIssuedAt.Add(-Tolerance)) {
		return ErrUntrusted
	}
	return nil
}

// Fixed is a clock for tests.
type Fixed struct {
	T      time.Time
	Synced bool
}

// Now returns the fixed time.
func (f *Fixed) Now() time.Time { return f.T }

// Synchronized returns the fixed state.
func (f *Fixed) Synchronized() (bool, error) { return f.Synced, nil }

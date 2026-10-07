//go:build e2e

package main

import (
	"os"
	"strconv"
	"time"
)

// Test seams of the end-to-end test (apps/server/test/agent-e2e.int.test.ts),
// compiled only with -tags e2e: the operator configuration may be owned by
// the test user, and the host clock counts as synchronized (CI and
// container clocks often are not, and the agent would rightly refuse every
// job). The clock is still the real one; only its synchronization flag is
// assumed.
func init() {
	e2eSeams = func(d *deps) {
		if v := os.Getenv("EXPONETDB_NODE_E2E_CONFIG_UID"); v != "" {
			if uid, err := strconv.Atoi(v); err == nil {
				d.configOwnerUID = uid
			}
		}
		if os.Getenv("EXPONETDB_NODE_E2E_CLOCK") == "synchronized" {
			d.clock = assumedSynchronized{}
		}
	}
}

type assumedSynchronized struct{}

func (assumedSynchronized) Now() time.Time              { return time.Now() }
func (assumedSynchronized) Synchronized() (bool, error) { return true, nil }

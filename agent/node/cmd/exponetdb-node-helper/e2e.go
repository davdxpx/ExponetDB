//go:build e2e

package main

import (
	"fmt"
	"os"
	"strings"
	"time"
)

// Test seam of the end-to-end test of capability operations
// (apps/server/test/agent-capabilities.host.test.ts), compiled only with
// -tags e2e: the host clock counts as synchronized, as in the agent's e2e
// build (CI and container clocks often are not, and the helper would rightly
// refuse every job). The clock is still the real one; only its
// synchronization flag is assumed. Such a build announces itself: its
// version carries the prerelease identifier "e2e", and it says so on
// standard error.
func init() {
	if strings.Contains(version, "-") {
		version += ".e2e"
	} else {
		version += "-e2e"
	}
	e2eSeams = func(d *deps) {
		fmt.Fprintln(d.stderr, "exponetdb-node-helper: built with end-to-end test seams; never a release build")
		if os.Getenv("EXPONETDB_NODE_E2E_CLOCK") == "synchronized" {
			d.clock = assumedSynchronized{}
		}
	}
}

type assumedSynchronized struct{}

func (assumedSynchronized) Now() time.Time              { return time.Now() }
func (assumedSynchronized) Synchronized() (bool, error) { return true, nil }

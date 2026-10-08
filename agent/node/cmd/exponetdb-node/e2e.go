//go:build e2e

package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Test seams of the end-to-end test (apps/server/test/agent-e2e.int.test.ts),
// compiled only with -tags e2e: the operator configuration may be owned by
// the test user, and the host clock counts as synchronized (CI and
// container clocks often are not, and the agent would rightly refuse every
// job). The clock is still the real one; only its synchronization flag is
// assumed.
//
// Such a build announces itself: its version carries the prerelease
// identifier "e2e" (the contract's semantic version has no build metadata),
// which hello reports and the node reads show, and it says so on standard
// error.
func init() {
	if strings.Contains(version, "-") {
		version += ".e2e"
	} else {
		version += "-e2e"
	}
	e2eSeams = func(d *deps) {
		fmt.Fprintln(d.stderr, "exponetdb-node: built with end-to-end test seams; never a release build")
		if v := os.Getenv("EXPONETDB_NODE_E2E_CONFIG_UID"); v != "" {
			if uid, err := strconv.Atoi(v); err == nil {
				d.configOwnerUID = uid
			}
		}
		if os.Getenv("EXPONETDB_NODE_E2E_CLOCK") == "synchronized" {
			d.clock = assumedSynchronized{}
		}
		if path := os.Getenv("EXPONETDB_NODE_E2E_FAULTS"); path != "" {
			d.boundary = func(capability, point string) { fault(path, capability, point) }
		}
	}
}

// fault injects one failure at a job boundary (agent.Options.Boundary) for
// the failure-injection test (apps/server/test/agent-capabilities.host.test.ts):
// the file names "<capability> <point> crash" or "<capability> <point> hold".
// A crash removes the file (so it happens once) and kills the process with
// SIGKILL, as a host failure would; a hold waits while the file exists (a
// partition or a stalled agent), then goes on.
func fault(path, capability, point string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	f := strings.Fields(string(data))
	if len(f) != 3 || f[0] != capability || f[1] != point {
		return
	}
	switch f[2] {
	case "crash":
		if os.Remove(path) == nil {
			_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
			select {}
		}
	case "hold":
		for {
			if _, err := os.Stat(path); err != nil {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
}

type assumedSynchronized struct{}

func (assumedSynchronized) Now() time.Time              { return time.Now() }
func (assumedSynchronized) Synchronized() (bool, error) { return true, nil }

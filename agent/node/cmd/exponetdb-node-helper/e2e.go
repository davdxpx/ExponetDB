//go:build e2e

package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"
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
		if path := os.Getenv("EXPONETDB_NODE_HELPER_E2E_FAULTS"); path != "" {
			d.boundary = func(op, point string) { fault(path, op, point) }
		}
	}
}

// fault injects one failure at an effect point of the helper (Helper.Boundary)
// for the host scenarios (apps/server/test/host/): the file names
// "<op> <point> crash" or "<op> <point> hold". A crash removes the file (so
// it happens once) and kills the process with SIGKILL, as a host failure
// would; a hold waits while the file exists, then goes on.
func fault(path, op, point string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	f := strings.Fields(string(data))
	if len(f) != 3 || f[0] != op || f[1] != point {
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

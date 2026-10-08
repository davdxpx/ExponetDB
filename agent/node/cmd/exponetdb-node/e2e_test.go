//go:build e2e

package main

import (
	"strings"
	"testing"
)

// An e2e build carries "e2e" in its version, so it can never pass for a
// release.
func TestE2EBuildAnnouncesItself(t *testing.T) {
	if e2eSeams == nil || !strings.HasSuffix(version, "e2e") {
		t.Fatalf("version %q", version)
	}
}

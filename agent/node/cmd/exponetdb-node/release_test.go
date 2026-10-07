//go:build !e2e

package main

import "testing"

// A build without the e2e tag (every release build) has no test seams.
func TestReleaseBuildHasNoTestSeams(t *testing.T) {
	if e2eSeams != nil {
		t.Fatal("test seams in a release build")
	}
}

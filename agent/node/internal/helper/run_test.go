package helper

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestExecRunner(t *testing.T) {
	if _, err := (ExecRunner{}).Run(context.Background(), Command{Path: "/bin/sh", Args: []string{"-c", "id"}}); err == nil {
		t.Fatal("a binary outside the allowlist ran")
	}
	// The fixed environment, with a test binary allowlisted for this test only.
	binaries["/usr/bin/env"] = true
	binaries["/usr/bin/sleep"] = true
	binaries["/usr/bin/head"] = true
	t.Cleanup(func() {
		delete(binaries, "/usr/bin/env")
		delete(binaries, "/usr/bin/sleep")
		delete(binaries, "/usr/bin/head")
	})
	t.Setenv("EXPONETDB_SECRET_FOR_TEST", "x")
	out, err := (ExecRunner{}).Run(context.Background(), Command{Path: "/usr/bin/env"})
	if err != nil {
		t.Fatal(err)
	}
	env := string(out.Stdout)
	if strings.Contains(env, "EXPONETDB_SECRET_FOR_TEST") || !strings.Contains(env, "LC_ALL=C\n") ||
		!strings.Contains(env, "PATH=/usr/sbin:/usr/bin:/sbin:/bin\n") {
		t.Fatalf("environment %q", env)
	}
	start := time.Now()
	if _, err := (ExecRunner{}).Run(context.Background(), Command{Path: "/usr/bin/sleep", Args: []string{"10"}, Timeout: 200 * time.Millisecond}); err == nil ||
		time.Since(start) > 8*time.Second {
		t.Fatalf("timeout not enforced: %v", err)
	}
	if _, err := (ExecRunner{}).Run(context.Background(), Command{Path: "/usr/bin/head", Args: []string{"-c", "2000000", "/dev/zero"}}); !errors.Is(err, ErrOutputTooLarge) {
		t.Fatalf("output cap: %v", err)
	}
	out, err = (ExecRunner{}).Run(context.Background(), Command{Path: "/usr/bin/sleep", Args: []string{"x"}})
	if err != nil || out.ExitCode == 0 {
		t.Fatalf("a failing command: %v %d", err, out.ExitCode)
	}
}

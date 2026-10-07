package helper

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"time"
)

// The binaries the helper runs: absolute paths, fixed here, never taken from
// a request or the configuration.
const (
	Systemctl = "/usr/bin/systemctl"
	DpkgQuery = "/usr/bin/dpkg-query"
	AptCache  = "/usr/bin/apt-cache"
	AptGet    = "/usr/bin/apt-get"
	maxOutput = 1 << 20
	// runTimeout is a command's default; restartTimeout a PostgreSQL
	// restart's (a shutdown checkpoint can take minutes); maxTimeout caps both.
	runTimeout     = 60 * time.Second
	restartTimeout = 10 * time.Minute
	maxTimeout     = 15 * time.Minute
)

var binaries = map[string]bool{Systemctl: true, DpkgQuery: true, AptCache: true, AptGet: true}

// Command is one execution: a fixed binary and an argv the helper built.
type Command struct {
	Path    string
	Args    []string
	Timeout time.Duration
}

// Output is what the helper reads of an execution: standard output and the
// exit code. Standard error is discarded (it is never returned or logged).
type Output struct {
	Stdout   []byte
	ExitCode int
}

// Runner executes commands; tests replace it.
type Runner interface {
	Run(ctx context.Context, c Command) (Output, error)
}

// ExecRunner runs a command without a shell, with a fixed environment, the
// root directory as working directory, no standard input, a timeout and an
// output cap.
type ExecRunner struct{}

// ErrOutputTooLarge: the command wrote more than the cap.
var ErrOutputTooLarge = errors.New("helper: command output too large")

type capped struct {
	buf      bytes.Buffer
	exceeded bool
}

func (c *capped) Write(p []byte) (int, error) {
	if c.buf.Len()+len(p) > maxOutput {
		c.exceeded = true
		return 0, ErrOutputTooLarge
	}
	return c.buf.Write(p)
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// Run executes c.
func (ExecRunner) Run(ctx context.Context, c Command) (Output, error) {
	if !binaries[c.Path] {
		return Output{}, errors.New("helper: binary not allowlisted")
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = runTimeout
	}
	timeout = min(timeout, maxTimeout)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.Path, c.Args...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C", "LANG=C", "SYSTEMD_PAGER=", "SYSTEMD_COLORS=0", "DEBIAN_FRONTEND=noninteractive"}
	cmd.Dir = "/"
	cmd.Stdin = nil
	out := &capped{}
	cmd.Stdout = out
	cmd.Stderr = discard{}
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	if out.exceeded {
		return Output{}, ErrOutputTooLarge
	}
	if ctx.Err() != nil {
		return Output{}, ctx.Err()
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return Output{Stdout: out.buf.Bytes(), ExitCode: exit.ExitCode()}, nil
	}
	if err != nil {
		return Output{}, err
	}
	return Output{Stdout: out.buf.Bytes()}, nil
}

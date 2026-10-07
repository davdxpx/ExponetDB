// Command exponetdb-node-helper is the ExponetDB node agent's root helper
// (architecture.md §2):
//
//	exponetdb-node-helper serve                     serve the agent (systemd socket or --socket)
//	exponetdb-node-helper trust --agent-state DIR   copy a freshly enrolled agent's trust
//	exponetdb-node-helper version                   print the version
//
// It runs as root, accepts only the agent user's uid, and performs a fixed
// set of typed operations, each authorized by a signed job it verifies
// itself against its own root-owned trust.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helper"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
)

// version is set at build time (-ldflags "-X main.version=1.0.0").
var version = "0.0.0-dev"

// deps are what main takes from the process; tests replace them.
type deps struct {
	stdout, stderr io.Writer
	ownerUID       int
	clock          clock.Clock
	runner         helper.Runner
	lookupUser     func(name string) (uid, gid int, err error)
	listen         func(path string, gid int) (*net.UnixListener, error)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], deps{
		stdout: os.Stdout, stderr: os.Stderr, ownerUID: 0, clock: clock.System{},
		runner: helper.ExecRunner{}, lookupUser: lookupUser, listen: listen,
	}))
}

func lookupUser(name string) (int, int, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return 0, 0, err
	}
	uid, err1 := strconv.Atoi(u.Uid)
	gid, err2 := strconv.Atoi(u.Gid)
	if err1 != nil || err2 != nil {
		return 0, 0, errors.New("the agent user has no numeric ids")
	}
	return uid, gid, nil
}

func listen(path string, gid int) (*net.UnixListener, error) {
	l, err := helper.SystemdListener()
	if err != nil || l != nil {
		return l, err
	}
	return helper.Listen(path, gid)
}

func run(ctx context.Context, args []string, d deps) int {
	if len(args) == 0 {
		fmt.Fprintln(d.stderr, "usage: exponetdb-node-helper serve|trust|version")
		return 2
	}
	command := args[0]
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(d.stderr)
	configPath := fs.String("config", config.DefaultPath, "operator configuration (root-owned)")
	trustPath := fs.String("trust", helper.DefaultTrustPath, "helper trust (root-owned)")
	stateDir := fs.String("state-dir", helper.DefaultStateDirectory, "helper state: effect ledger and staged keys")
	agentState := fs.String("agent-state", "", "trust: the enrolled agent's state directory")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	switch command {
	case "version":
		fmt.Fprintln(d.stdout, version)
		return 0
	case "trust":
		return trustCommand(*agentState, *trustPath, d)
	case "serve":
		if err := serve(ctx, *configPath, *trustPath, *stateDir, d); err != nil {
			fmt.Fprintln(d.stderr, "exponetdb-node-helper:", err)
			return 1
		}
		return 0
	}
	fmt.Fprintln(d.stderr, "usage: exponetdb-node-helper serve|trust|version")
	return 2
}

// trustCommand writes the helper trust from the agent's state right after
// enrollment, or again to resynchronize it (a recovery the operator runs).
func trustCommand(agentState, trustPath string, d deps) int {
	if agentState == "" {
		fmt.Fprintln(d.stderr, "trust: --agent-state is required")
		return 2
	}
	t, err := helper.TrustFromAgentState(agentState)
	if err == nil {
		err = helper.SaveTrust(trustPath, t)
	}
	if err != nil {
		fmt.Fprintln(d.stderr, "trust:", err)
		return 1
	}
	fmt.Fprintf(d.stdout, "trust written for node %s with %d job key(s)\n", t.NodeID, len(t.JobKeys))
	return 0
}

// privateDir creates or checks a root-only directory.
func privateDir(path string, ownerUID int) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || int(st.Uid) != ownerUID || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s must be a directory private to uid %d", path, ownerUID)
	}
	return nil
}

func serve(ctx context.Context, configPath, trustPath, stateDir string, d deps) error {
	cfg, err := config.Load(configPath, config.Options{OwnerUID: d.ownerUID})
	if err != nil {
		return err
	}
	if cfg.AgentUser == "" {
		return errors.New("the configuration names no agentUser")
	}
	uid, gid, err := d.lookupUser(cfg.AgentUser)
	if err != nil {
		return fmt.Errorf("agent user %s: %w", cfg.AgentUser, err)
	}
	if uid == 0 || uid == d.ownerUID {
		return errors.New("the agent user must not be root")
	}
	staging := filepath.Join(stateDir, "staging")
	for _, dir := range []string{stateDir, staging} {
		if err := privateDir(dir, d.ownerUID); err != nil {
			return err
		}
	}
	ledger, err := journal.OpenLedger(stateDir, "effects.log", d.clock.Now)
	if err != nil {
		return err
	}
	defer ledger.Close()
	if err := ledger.Compact(helper.LedgerRetention); err != nil {
		return err
	}
	sv, err := schema.Protocol()
	if err != nil {
		return err
	}
	h := &helper.Helper{
		Config: cfg, Schema: sv, Clock: d.clock, Ledger: ledger, Runner: d.runner,
		TrustPath: trustPath, TrustOwner: d.ownerUID, StagingDirectory: staging,
	}
	l, err := d.listen(cfg.HelperSocket, gid)
	if err != nil {
		return err
	}
	go func() {
		t := time.NewTicker(24 * time.Hour)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = ledger.Compact(helper.LedgerRetention)
			}
		}
	}()
	// Connections are served in parallel; one line is written at a time.
	var logMu sync.Mutex
	s := &helper.Server{Helper: h, AgentUID: uid, Log: func(format string, args ...any) {
		logMu.Lock()
		defer logMu.Unlock()
		fmt.Fprintf(d.stderr, format+"\n", args...)
	}}
	return s.Serve(ctx, l)
}

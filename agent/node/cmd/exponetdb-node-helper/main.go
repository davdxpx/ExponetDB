// Command exponetdb-node-helper is the ExponetDB node agent's root helper
// (architecture.md §2):
//
//	exponetdb-node-helper serve                     serve the agent (systemd socket activation)
//	exponetdb-node-helper trust --agent-state DIR [--expect-key FINGERPRINT]...
//	                                                copy a freshly enrolled agent's trust
//	exponetdb-node-helper trust --show              print the helper's trust
//	exponetdb-node-helper ledger init               create the effect ledger of a helper that never performed an effect
//	exponetdb-node-helper engine-run --run RUN_ID   execute an engine run (only inside its transient unit)
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
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsutil"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helper"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/kdigest"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
)

// version and commit are set at build time (packaging/build.sh:
// -ldflags "-X main.version=1.0.0 -X main.commit=<sha>").
var (
	version = "0.0.0-dev"
	commit  = "unknown"
)

// deps are what main takes from the process; tests replace them.
type deps struct {
	stdout, stderr io.Writer
	ownerUID       int
	clock          clock.Clock
	runner         helper.Runner
	lookupUser     func(name string) (uid, gid int, err error)
	listen         func(path string, gid, ownerUID int) (*net.UnixListener, error)
	// boundary is the e2e build's failure-injection seam (e2e.go); nil in a
	// release build.
	boundary func(op, point string)
}

// e2eSeams is set only in a build with the e2e tag (e2e.go), for the
// end-to-end test of capability operations; a release build has none.
var e2eSeams func(*deps)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	d := deps{
		stdout: os.Stdout, stderr: os.Stderr, ownerUID: 0, clock: clock.System{},
		runner: helper.ExecRunner{}, lookupUser: lookupUser, listen: listen,
	}
	if e2eSeams != nil {
		e2eSeams(&d)
	}
	os.Exit(run(ctx, os.Args[1:], d))
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

func listen(path string, gid, ownerUID int) (*net.UnixListener, error) {
	l, err := helper.SystemdListener()
	if err != nil || l != nil {
		return l, err
	}
	return helper.Listen(path, gid, ownerUID)
}

const usage = "usage: exponetdb-node-helper serve|trust|ledger init|engine-run|version"

// ledgerInitHelp is what `exponetdb-node-helper ledger init` is for
// (node-runbook.md).
const ledgerInitHelp = `exponetdb-node-helper ledger init [--state-dir DIR] [--trust PATH]

Creates the helper's effect ledger (<state-dir>/effects.log) and records its
initialization beside the trust file, for a helper that NEVER PERFORMED AN
EFFECT whose ledger is missing although it was initialized (its state
directory was recreated before the first job). The helper initializes its
ledger itself at its first start; once that is recorded, a missing ledger is
lost and the helper refuses every effect operation.

It refuses, and changes nothing, when the ledger exists. Never run it for a
helper that performed an effect: decommission the node, enroll the host
again as a new node and run "exponetdb-node-helper trust" for it first
(node-runbook.md, "Replay state missing"). Run it as root with the helper
stopped.
`

func run(ctx context.Context, args []string, d deps) int {
	if len(args) == 0 {
		fmt.Fprintln(d.stderr, usage)
		return 2
	}
	command, rest := args[0], args[1:]
	if command == "ledger" {
		if len(rest) == 0 || rest[0] != "init" {
			fmt.Fprint(d.stderr, ledgerInitHelp)
			return 2
		}
		command, rest = "ledger init", rest[1:]
	}
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(d.stderr)
	if command == "ledger init" {
		fs.Usage = func() { fmt.Fprint(d.stderr, ledgerInitHelp) }
	}
	configPath := fs.String("config", config.DefaultPath, "operator configuration (root-owned)")
	trustPath := fs.String("trust", helper.DefaultTrustPath, "helper trust (root-owned)")
	stateDir := fs.String("state-dir", helper.DefaultStateDirectory, "helper state: effect ledger and staged keys")
	agentState := fs.String("agent-state", "", "trust: the enrolled agent's state directory")
	show := fs.Bool("show", false, "trust: print the helper's trust")
	runID := fs.String("run", "", "engine-run: the run id")
	var expect multiFlag
	fs.Var(&expect, "expect-key", "trust: a job key fingerprint the agent's state must hold (repeatable)")
	if err := fs.Parse(rest); err != nil {
		return 2
	}
	switch command {
	case "version":
		fmt.Fprintf(d.stdout, "%s commit %s\n", version, commit)
		return 0
	case "trust":
		if *show {
			return showTrust(*trustPath, d)
		}
		return trustCommand(*agentState, *trustPath, expect, d)
	case "ledger init":
		return ledgerInitCommand(*stateDir, *trustPath, d)
	case "engine-run":
		return engineRun(ctx, *runID, d)
	case "serve":
		if err := serve(ctx, *configPath, *trustPath, *stateDir, d); err != nil {
			fmt.Fprintln(d.stderr, "exponetdb-node-helper:", err)
			return 1
		}
		return 0
	}
	fmt.Fprintln(d.stderr, usage)
	return 2
}

// ledgerInitCommand creates the ledger of a helper that never performed an
// effect (ledgerInitHelp); it never replaces or empties a ledger.
func ledgerInitCommand(stateDir, trustPath string, d deps) int {
	if err := privateDir(stateDir, d.ownerUID); err != nil {
		fmt.Fprintln(d.stderr, "ledger init:", err)
		return 1
	}
	if err := fsutil.CheckParent(helper.LedgerRecordPath(trustPath), d.ownerUID); err != nil {
		fmt.Fprintln(d.stderr, "ledger init:", err)
		return 1
	}
	if err := helper.InitLedger(stateDir, trustPath, d.clock.Now); err != nil {
		if errors.Is(err, journal.ErrExists) {
			fmt.Fprintf(d.stderr, "ledger init: %s exists; nothing was changed (a ledger is never replaced or emptied)\n",
				filepath.Join(stateDir, helper.LedgerFile))
			return 1
		}
		fmt.Fprintln(d.stderr, "ledger init:", err)
		return 1
	}
	fmt.Fprintf(d.stdout, "effect ledger initialized: %s (recorded in %s)\n",
		filepath.Join(stateDir, helper.LedgerFile), helper.LedgerRecordPath(trustPath))
	return 0
}

// engineRun executes one engine run (ADR-0037 §2): the helper starts it as
// a transient unit running as the PostgreSQL server's user, with the run id
// as its only argument; everything else comes from the root-written run
// record. It never runs as root.
func engineRun(ctx context.Context, runID string, d deps) int {
	if os.Geteuid() == 0 {
		fmt.Fprintln(d.stderr, "engine-run: never runs as root; it runs in its transient unit as the engine user")
		return 2
	}
	if !helper.ValidRunID(runID) {
		fmt.Fprintln(d.stderr, "engine-run: --run names no run id")
		return 2
	}
	if err := helper.EngineRun(ctx, helper.EngineOptions{RunsRoot: helper.DefaultPaths.Engine + "/runs", RunID: runID}); err != nil {
		fmt.Fprintln(d.stderr, "engine-run: the run's outcome could not be recorded")
		return 1
	}
	return 0
}

// multiFlag collects a repeatable flag.
type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func printKeys(w io.Writer, t *helper.Trust) {
	for _, k := range t.JobKeys {
		pub, _ := nodecrypto.FromB64UOf(k.PublicKey, 32)
		fmt.Fprintf(w, "  job key %s %s\n", k.KeyID, nodecrypto.KeyFingerprint(pub))
	}
}

// trustCommand writes the helper trust from the agent's state right after
// enrollment, or again to resynchronize it (a recovery the operator runs).
// The agent's state is the agent's word: the operator compares the printed
// fingerprints with the Control Plane's job keys, or names them with
// --expect-key, and nothing is written unless every key is expected
// (architecture.md §2, residuals).
func trustCommand(agentState, trustPath string, expect []string, d deps) int {
	if agentState == "" {
		fmt.Fprintln(d.stderr, "trust: --agent-state is required")
		return 2
	}
	t, err := helper.TrustFromAgentState(agentState)
	if err != nil {
		fmt.Fprintln(d.stderr, "trust:", err)
		return 1
	}
	if len(expect) > 0 {
		for _, k := range t.JobKeys {
			pub, _ := nodecrypto.FromB64UOf(k.PublicKey, 32)
			fp := nodecrypto.KeyFingerprint(pub)
			found := false
			for _, e := range expect {
				found = found || nodecrypto.SameFingerprint(fp, e)
			}
			if !found {
				fmt.Fprintf(d.stderr, "trust: job key %s (%s) is not expected; nothing written\n", k.KeyID, fp)
				return 1
			}
		}
	}
	if err := helper.SaveTrust(trustPath, t); err != nil {
		fmt.Fprintln(d.stderr, "trust:", err)
		return 1
	}
	fmt.Fprintf(d.stdout, "trust written for node %s (installation %s):\n", t.NodeID, t.InstallationID)
	printKeys(d.stdout, t)
	return 0
}

// showTrust prints the helper's trust: a retirement the agent withheld shows
// as a key the Control Plane no longer lists.
func showTrust(trustPath string, d deps) int {
	t, err := helper.LoadTrust(trustPath, d.ownerUID)
	if err != nil {
		fmt.Fprintln(d.stderr, "trust:", err)
		return 1
	}
	fmt.Fprintf(d.stdout, "node %s (installation %s):\n", t.NodeID, t.InstallationID)
	printKeys(d.stdout, t)
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
	for _, in := range cfg.Instances {
		if info, err := os.Stat(in.DataDirectory); err == nil {
			if st, ok := info.Sys().(*syscall.Stat_t); ok && int(st.Uid) == uid {
				return fmt.Errorf("the agent user owns the data directory of %s; it must not be the PostgreSQL user", in.LocalName)
			}
		}
	}
	// The TLS installation record lives here and is opened by path from "/".
	if stateDir, err = filepath.Abs(stateDir); err != nil {
		return err
	}
	staging := filepath.Join(stateDir, "staging")
	for _, dir := range []string{stateDir, staging} {
		if err := privateDir(dir, d.ownerUID); err != nil {
			return err
		}
	}
	// The ledger by its initialization rule: created at the first start,
	// never recreated once that is recorded. A lost ledger refuses every
	// effect; the read-only operations stay available.
	ledger, err := helper.OpenLedger(stateDir, trustPath, d.ownerUID, d.clock.Now)
	switch {
	case errors.Is(err, helper.ErrLedgerLost):
		fmt.Fprintln(d.stderr, "exponetdb-node-helper:", err)
	case err != nil:
		return err
	}
	defer ledger.Close()
	sv, err := schema.Protocol()
	if err != nil {
		return err
	}
	// The helper's own digest key (capabilities.md §6): created once in its
	// private state directory, never sent.
	digestKey, err := kdigest.LoadOrCreateHelperKey(filepath.Join(stateDir, "digest.key"), d.ownerUID)
	if err != nil {
		return err
	}
	h := &helper.Helper{
		Config: cfg, Schema: sv, Clock: d.clock, Ledger: ledger, Runner: d.runner,
		TrustPath: trustPath, TrustOwner: d.ownerUID, StagingDirectory: staging, StateDirectory: stateDir,
		DigestKey: digestKey, Boundary: d.boundary,
	}
	// An interrupted TLS installation is settled from its record before
	// anything else changes (architecture.md §2, item 9). One that cannot be
	// settled is said here for the operator; the helper still serves reads
	// and refuses every change until it is resolved (node-runbook.md §7).
	if did, err := h.SettleTLSInstall(); err != nil {
		fmt.Fprintln(d.stderr, "exponetdb-node-helper:", err)
	} else if did != "" {
		fmt.Fprintln(d.stderr, "exponetdb-node-helper:", did)
	}
	if ledger.Err() == nil {
		if err := ledger.Compact(helper.LedgerRetention); err != nil {
			return err
		}
	}
	l, err := d.listen(cfg.HelperSocket, gid, d.ownerUID)
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

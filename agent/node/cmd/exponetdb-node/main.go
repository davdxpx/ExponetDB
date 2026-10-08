// Command exponetdb-node is the ExponetDB node agent (architecture.md):
//
//	exponetdb-node enroll --token-file PATH|-   enroll this host with a token
//	exponetdb-node run                          run the agent
//	exponetdb-node status                       show the node's identity and journal
//	exponetdb-node journal init                 create the replay files of a node that never accepted a job
//	exponetdb-node version                      print the version
//
// The enrollment token is read from a file or standard input, never from the
// command line, where other local users could read it. Every command takes
// --config (default /etc/exponetdb-node/config.json), a root-owned file.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/capabilities"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/enroll"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperclient"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/kdigest"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
)

// version and commit are set at build time (packaging/build.sh:
// -ldflags "-X main.version=1.0.0 -X main.commit=<sha>").
var (
	version = "0.0.0-dev"
	commit  = "unknown"
)

// deps are what main takes from the process; tests replace them.
type deps struct {
	stdin          io.Reader
	stdout, stderr io.Writer
	configOwnerUID int
	clock          clock.Clock
	host           agent.Host
	dial           string
	// boundary injects failures at job boundaries (e2e builds only).
	boundary func(capability, point string)
}

// e2eSeams is set only in a build with the e2e tag (e2e.go), for the
// end-to-end test against a real gateway; a release build has none.
var e2eSeams func(*deps)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	d := deps{
		stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr,
		configOwnerUID: 0, clock: clock.System{}, host: &agent.Linux{},
	}
	if e2eSeams != nil {
		e2eSeams(&d)
	}
	os.Exit(run(ctx, os.Args[1:], d))
}

const usage = "usage: exponetdb-node enroll|run|status|journal init|version [--config PATH]"

// journalInitHelp is what `exponetdb-node journal init` is for (node-runbook.md).
const journalInitHelp = `exponetdb-node journal init [--config PATH]

Creates the agent's replay files (journal/journal.log and journal/nonces.log)
for a node that NEVER RAN A JOB: a node enrolled by a release that did not
create them at enrollment and never started since. Enrollment creates them
now; once they exist, a missing one is lost replay state and the agent
refuses every job (journal_corrupt).

It refuses, and changes nothing, when either file exists, when the host is
not enrolled, or when the node's state records an accepted job: then the
replay state was lost, and only enrolling the host again as a new node is
safe (node-runbook.md, "Replay state missing"). Run it as the agent's user
with the agent stopped.
`

func run(ctx context.Context, args []string, d deps) int {
	if len(args) == 0 {
		fmt.Fprintln(d.stderr, usage)
		return 2
	}
	command, rest := args[0], args[1:]
	if command == "journal" {
		if len(rest) == 0 || rest[0] != "init" {
			fmt.Fprint(d.stderr, journalInitHelp)
			return 2
		}
		command, rest = "journal init", rest[1:]
	}
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(d.stderr)
	if command == "journal init" {
		fs.Usage = func() { fmt.Fprint(d.stderr, journalInitHelp) }
	}
	configPath := fs.String("config", config.DefaultPath, "operator configuration (root-owned)")
	tokenFile := fs.String("token-file", "", "enroll: file with the enrollment token, or - for standard input")
	if err := fs.Parse(rest); err != nil {
		return 2
	}
	if command == "version" {
		fmt.Fprintf(d.stdout, "%s commit %s\n", version, commit)
		return 0
	}
	cfg, err := config.Load(*configPath, config.Options{OwnerUID: d.configOwnerUID})
	if err != nil {
		fmt.Fprintln(d.stderr, err)
		return 1
	}
	store, err := state.Open(cfg.StateDirectory, os.Getuid())
	if err != nil {
		fmt.Fprintln(d.stderr, err)
		return 1
	}
	v, err := schema.Protocol()
	if err != nil {
		fmt.Fprintln(d.stderr, err)
		return 1
	}
	switch command {
	case "enroll", "run", "journal init":
		lock, lerr := store.Lock()
		if lerr != nil {
			fmt.Fprintln(d.stderr, lerr)
			return 1
		}
		defer lock.Close()
		switch command {
		case "enroll":
			err = enrollCommand(ctx, *tokenFile, store, v, d)
		case "run":
			err = runCommand(ctx, cfg, store, v, d)
		default:
			err = journalInitCommand(store, d)
		}
	case "status":
		err = statusCommand(store, d)
	default:
		fmt.Fprintf(d.stderr, "unknown command %q\n%s\n", command, usage)
		return 2
	}
	if err != nil {
		fmt.Fprintln(d.stderr, err)
		return 1
	}
	return 0
}

func readToken(path string, stdin io.Reader) (string, error) {
	var r io.Reader
	switch path {
	case "":
		return "", errors.New("enroll: --token-file is required (a file, or - for standard input)")
	case "-":
		r = stdin
	default:
		f, err := os.Open(path)
		if err != nil {
			return "", err
		}
		defer f.Close()
		r = f
	}
	line, err := bufio.NewReader(io.LimitReader(r, 8192)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

func enrollCommand(ctx context.Context, tokenFile string, store *state.Store, v *schema.Validator, d deps) error {
	if _, err := store.LoadState(); !errors.Is(err, state.ErrNotEnrolled) {
		return errors.New("enroll: this host is already enrolled (or its state is damaged); a re-installed host is a new node, remove the old state first")
	}
	// The replay files first, durably, before the token is spent: an
	// enrolled node always has them, so a missing one is lost replay state
	// (architecture.md §4). Files left by an earlier attempt are kept.
	if err := journal.Init(store.Path(state.JournalDir)); err != nil {
		return fmt.Errorf("enroll: initializing the journal: %w", err)
	}
	// This release classifies every export: what its buffer will hold is
	// sent as stored (capabilities.md §6).
	if err := agent.MarkClassified(store.Path(state.BufferDir)); err != nil {
		return fmt.Errorf("enroll: initializing the result buffer: %w", err)
	}
	token, err := readToken(tokenFile, d.stdin)
	if err != nil {
		return err
	}
	facts, err := d.host.Facts()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	res, err := enroll.Enroll(ctx, token, enroll.Options{
		AgentVersion: version, Host: facts, Schema: v, Now: d.clock.Now, Dial: d.dial,
	})
	if err != nil {
		return err
	}
	// Identity first: a state file means "enrolled" and must never point to
	// keys that are not on disk.
	if err := store.SaveIdentity(res.Identity); err != nil {
		return err
	}
	if err := store.SaveState(res.State); err != nil {
		return err
	}
	fmt.Fprintf(d.stdout, "enrolled as %s (installation %s, server %s); certificate valid until %s\n",
		res.State.NodeID, res.State.InstallationID, res.State.ServerID, res.Identity.CertificateExpiresAt)
	return nil
}

func runCommand(ctx context.Context, cfg *config.Config, store *state.Store, v *schema.Validator, d deps) error {
	logger := slog.New(slog.NewJSONHandler(d.stderr, nil))
	helper := &helperclient.Client{Socket: cfg.HelperSocket}
	// The key of the agent's digests over state that may hold a withheld
	// value (capabilities.md §6): derived from the node encryption secret,
	// never stored or sent.
	id, err := store.LoadIdentity()
	if err != nil {
		return err
	}
	digestKey, err := kdigest.AgentKey(state.Seed(id.NodeEncryptionSecret))
	if err != nil {
		return err
	}
	env := &capabilities.Env{Config: cfg, Helper: helper, Clock: d.clock, DigestKey: digestKey}
	a, err := agent.New(agent.Options{
		Config: cfg, Store: store, Version: version, Clock: d.clock, Host: d.host, Schema: v,
		Logger: logger, Dial: d.dial, Helper: helper,
		Capabilities: capabilities.All(env), Inventory: capabilities.Inventory(env),
		Boundary: d.boundary,
	})
	if err != nil {
		return err
	}
	logger.Info("agent started", "version", version, "commit", commit)
	return a.Run(ctx)
}

func statusCommand(store *state.Store, d deps) error {
	st, err := store.LoadState()
	if err != nil {
		return err
	}
	id, err := store.LoadIdentity()
	if err != nil {
		return err
	}
	fmt.Fprintf(d.stdout, "node %s\ninstallation %s\nserver %s\ngateway %s (%s)\ncertificate expires %s\njob keys",
		st.NodeID, st.InstallationID, st.ServerID, st.GatewayURL, st.GatewayServerName, id.CertificateExpiresAt)
	for _, k := range st.JobKeys {
		fmt.Fprintf(d.stdout, " %s", k.KeyID)
	}
	fmt.Fprintln(d.stdout)
	// Read-only: the running agent may be writing the journal right now.
	j, err := journal.OpenReadOnly(store.Path(state.JournalDir), d.clock.Now)
	if errors.Is(err, journal.ErrMissing) {
		fmt.Fprintln(d.stdout, "journal missing: the agent refuses every job (journal_corrupt); "+
			"`exponetdb-node journal init` only for a node that never accepted a job, otherwise enroll again (node-runbook.md)")
		return nil
	}
	if err != nil {
		fmt.Fprintf(d.stdout, "journal: %v\n", err)
		return nil
	}
	defer j.Close()
	s := j.Stats()
	fmt.Fprintf(d.stdout, "journal %d jobs, %d bytes, %d in flight\n", s.Jobs, s.Bytes, len(j.InFlight()))
	return nil
}

// journalInitCommand creates the replay files of an enrolled node that never
// accepted a job (journalInitHelp). It never replaces, empties or completes
// a replay file: one that exists, or a state that records an accepted job,
// refuses it.
func journalInitCommand(store *state.Store, d deps) error {
	st, err := store.LoadState()
	if errors.Is(err, state.ErrNotEnrolled) {
		return errors.New("journal init: this host is not enrolled; enrollment creates the journal")
	}
	if err != nil {
		return err
	}
	dir := store.Path(state.JournalDir)
	present, err := journal.Present(dir)
	if err != nil {
		return err
	}
	if len(present) > 0 {
		return fmt.Errorf("journal init: %s exists; nothing was changed (a replay file is never replaced, emptied or completed: "+
			"if the other one is missing, the replay state was lost; enroll the host again, node-runbook.md)", strings.Join(present, " and "))
	}
	if st.HighestIssuedAt != "" {
		return fmt.Errorf("journal init: node %s accepted a job (the latest issued at %s), so its replay files were lost, "+
			"not never created; nothing was changed. Decommission the node and enroll the host again (node-runbook.md)",
			st.NodeID, st.HighestIssuedAt)
	}
	if err := journal.Init(dir); err != nil {
		return err
	}
	fmt.Fprintf(d.stdout, "journal initialized for node %s (journal.log, nonces.log); the agent accepts jobs at its next start\n", st.NodeID)
	return nil
}

// Command exponetdb-node is the ExponetDB node agent (architecture.md):
//
//	exponetdb-node enroll --token-file PATH|-   enroll this host with a token
//	exponetdb-node run                          run the agent
//	exponetdb-node status                       show the node's identity and journal
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
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/enroll"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
)

// version is set at build time (-ldflags "-X main.version=1.0.0").
var version = "0.0.0-dev"

// deps are what main takes from the process; tests replace them.
type deps struct {
	stdin          io.Reader
	stdout, stderr io.Writer
	configOwnerUID int
	clock          clock.Clock
	host           agent.Host
	dial           string
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

func run(ctx context.Context, args []string, d deps) int {
	if len(args) == 0 {
		fmt.Fprintln(d.stderr, "usage: exponetdb-node enroll|run|status|version [--config PATH]")
		return 2
	}
	command := args[0]
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(d.stderr)
	configPath := fs.String("config", config.DefaultPath, "operator configuration (root-owned)")
	tokenFile := fs.String("token-file", "", "enroll: file with the enrollment token, or - for standard input")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	if command == "version" {
		fmt.Fprintln(d.stdout, version)
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
	case "enroll", "run":
		lock, lerr := store.Lock()
		if lerr != nil {
			fmt.Fprintln(d.stderr, lerr)
			return 1
		}
		defer lock.Close()
		if command == "enroll" {
			err = enrollCommand(ctx, *tokenFile, store, v, d)
		} else {
			err = runCommand(ctx, cfg, store, v, d)
		}
	case "status":
		err = statusCommand(store, d)
	default:
		fmt.Fprintf(d.stderr, "unknown command %q\n", command)
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
	a, err := agent.New(agent.Options{
		Config: cfg, Store: store, Version: version, Clock: d.clock, Host: d.host, Schema: v,
		Logger: logger, Dial: d.dial,
	})
	if err != nil {
		return err
	}
	logger.Info("agent started", "version", version)
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
	if errors.Is(err, os.ErrNotExist) {
		fmt.Fprintln(d.stdout, "journal 0 jobs, 0 bytes, 0 in flight")
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

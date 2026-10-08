package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
	"github.com/davdxpx/ExponetDB/agent/node/internal/testgateway"
)

type fakeHost struct{}

func (fakeHost) Facts() (protocol.HostFacts, error) {
	return protocol.HostFacts{Hostname: "db-host-01", Os: "ubuntu 24.04", Kernel: "6.8.0", Cpus: 8,
		MemoryBytes: 1 << 34, MachineIDHash: "sha256:" + strings.Repeat("3", 64)}, nil
}

func (fakeHost) Metrics([]string) (protocol.HeartbeatRequestHost, error) {
	return protocol.HeartbeatRequestHost{Mounts: []protocol.HeartbeatRequestHostMount{}}, nil
}

func setup(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")
	if err := os.Mkdir(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg, _ := json.Marshal(config.Config{Schema: config.Schema, StateDirectory: stateDir,
		HelperSocket: "/run/exponetdb-node/helper.sock", DisabledCapabilities: []string{}, Instances: []config.Instance{}})
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	return path, stateDir
}

func TestEnrollStatusAndVersion(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	gw := testgateway.New(t, now)
	configPath, _ := setup(t)
	var out, errs bytes.Buffer
	d := deps{stdin: strings.NewReader(gw.Token(now.Add(30*time.Minute)) + "\n"), stdout: &out, stderr: &errs,
		configOwnerUID: os.Getuid(), clock: &clock.Fixed{T: now, Synced: true}, host: fakeHost{}, dial: gw.URL()}

	if code := run(context.Background(), []string{"version"}, d); code != 0 || strings.TrimSpace(out.String()) != version+" commit "+commit {
		t.Fatalf("version: %d %q", code, out.String())
	}
	out.Reset()
	if code := run(context.Background(), []string{"enroll", "--config", configPath}, d); code != 1 || !strings.Contains(errs.String(), "--token-file") {
		t.Fatalf("enroll without a token file: %d %q", code, errs.String())
	}
	errs.Reset()
	if code := run(context.Background(), []string{"enroll", "--config", configPath, "--token-file", "-"}, d); code != 0 {
		t.Fatalf("enroll: %d %s", code, errs.String())
	}
	if !strings.Contains(out.String(), "enrolled as "+testgateway.NodeID) {
		t.Fatalf("enroll output %q", out.String())
	}
	d.stdin = strings.NewReader(gw.Token(now.Add(30*time.Minute)) + "\n")
	errs.Reset()
	if code := run(context.Background(), []string{"enroll", "--config", configPath, "--token-file", "-"}, d); code != 1 || !strings.Contains(errs.String(), "already enrolled") {
		t.Fatalf("second enroll: %d %q", code, errs.String())
	}
	out.Reset()
	if code := run(context.Background(), []string{"status", "--config", configPath}, d); code != 0 {
		t.Fatalf("status: %s", errs.String())
	}
	for _, want := range []string{testgateway.NodeID, "jobkey_2026_10", "journal 0 jobs"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("status lacks %q: %s", want, out.String())
		}
	}
	if strings.Contains(out.String(), "Seed") || strings.Contains(out.String(), "secret") {
		t.Fatal("status printed key material")
	}

	// run: one session, then stop.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	errs.Reset()
	if code := run(ctx, []string{"run", "--config", configPath}, d); code != 0 {
		t.Fatalf("run: %s", errs.String())
	}
	if len(gw.Hellos()) == 0 {
		t.Fatal("run never said hello")
	}
}

// Review finding F7 (replay state): enrollment initializes the journal and
// the nonce cache, so an enrolled node whose replay files are missing has
// lost them (never "not yet created").
func TestEnrollInitializesTheReplayFiles(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	gw := testgateway.New(t, now)
	configPath, stateDir := setup(t)
	var out, errs bytes.Buffer
	d := deps{stdin: strings.NewReader(gw.Token(now.Add(30*time.Minute)) + "\n"), stdout: &out, stderr: &errs,
		configOwnerUID: os.Getuid(), clock: &clock.Fixed{T: now, Synced: true}, host: fakeHost{}, dial: gw.URL()}
	if code := run(context.Background(), []string{"enroll", "--config", configPath, "--token-file", "-"}, d); code != 0 {
		t.Fatalf("enroll: %d %s", code, errs.String())
	}
	for _, name := range []string{"journal.log", "nonces.log"} {
		info, err := os.Lstat(filepath.Join(stateDir, "journal", name))
		if err != nil || !info.Mode().IsRegular() || info.Size() != 0 || info.Mode().Perm() != 0o600 {
			t.Fatalf("%s after enrollment: %v %v", name, info, err)
		}
	}
}

// `journal init` creates the replay files of an enrolled node that never
// accepted a job (enrolled by a release that did not create them), and only
// that: an existing file, a state that records an accepted job, or a host
// that is not enrolled refuses it and changes nothing.
func TestJournalInitIsOnlyForANodeThatNeverRan(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	gw := testgateway.New(t, now)
	configPath, stateDir := setup(t)
	var out, errs bytes.Buffer
	d := deps{stdin: strings.NewReader(gw.Token(now.Add(30*time.Minute)) + "\n"), stdout: &out, stderr: &errs,
		configOwnerUID: os.Getuid(), clock: &clock.Fixed{T: now, Synced: true}, host: fakeHost{}, dial: gw.URL()}
	initArgs := []string{"journal", "init", "--config", configPath}
	if code := run(context.Background(), initArgs, d); code != 1 || !strings.Contains(errs.String(), "not enrolled") {
		t.Fatalf("before enrollment: %d %q", code, errs.String())
	}
	if code := run(context.Background(), []string{"enroll", "--config", configPath, "--token-file", "-"}, d); code != 0 {
		t.Fatalf("enroll: %d %s", code, errs.String())
	}
	journalDir := filepath.Join(stateDir, "journal")
	errs.Reset()
	if code := run(context.Background(), initArgs, d); code != 1 || !strings.Contains(errs.String(), "journal.log and nonces.log exists") {
		t.Fatalf("over existing files: %d %q", code, errs.String())
	}
	// One file lost: never completed by init.
	if err := os.Remove(filepath.Join(journalDir, "nonces.log")); err != nil {
		t.Fatal(err)
	}
	errs.Reset()
	if code := run(context.Background(), initArgs, d); code != 1 || !strings.Contains(errs.String(), "journal.log exists") {
		t.Fatalf("with one file: %d %q", code, errs.String())
	}
	if _, err := os.Stat(filepath.Join(journalDir, "nonces.log")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("init completed a half-lost journal")
	}
	// A node that never ran: both files missing, no accepted job.
	if err := os.Remove(filepath.Join(journalDir, "journal.log")); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if code := run(context.Background(), []string{"status", "--config", configPath}, d); code != 0 || !strings.Contains(out.String(), "journal missing") {
		t.Fatalf("status without a journal: %d %q", code, out.String())
	}
	out.Reset()
	if code := run(context.Background(), initArgs, d); code != 0 || !strings.Contains(out.String(), "journal initialized") {
		t.Fatalf("init: %d %q %q", code, out.String(), errs.String())
	}
	for _, name := range []string{"journal.log", "nonces.log"} {
		if info, err := os.Lstat(filepath.Join(journalDir, name)); err != nil || info.Size() != 0 {
			t.Fatalf("%s: %v %v", name, info, err)
		}
	}
	// A node that accepted a job lost its replay state: refused.
	store, err := state.Open(stateDir, os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.LoadState()
	if err != nil {
		t.Fatal(err)
	}
	st.HighestIssuedAt = now.Format(time.RFC3339)
	if err := store.SaveState(st); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"journal.log", "nonces.log"} {
		if err := os.Remove(filepath.Join(journalDir, name)); err != nil {
			t.Fatal(err)
		}
	}
	errs.Reset()
	if code := run(context.Background(), initArgs, d); code != 1 || !strings.Contains(errs.String(), "accepted a job") {
		t.Fatalf("after an accepted job: %d %q", code, errs.String())
	}
	if present, _ := os.ReadDir(journalDir); len(present) != 0 {
		t.Fatalf("init wrote %v", present)
	}
	errs.Reset()
	if code := run(context.Background(), []string{"journal"}, d); code != 2 || !strings.Contains(errs.String(), "NEVER RAN A JOB") {
		t.Fatalf("help: %d %q", code, errs.String())
	}
}

func TestConfigOwnedByAnotherUserIsRefused(t *testing.T) {
	configPath, _ := setup(t)
	var out, errs bytes.Buffer
	d := deps{stdout: &out, stderr: &errs, configOwnerUID: os.Getuid() + 1, clock: clock.System{}, host: fakeHost{}}
	if code := run(context.Background(), []string{"status", "--config", configPath}, d); code != 1 || !strings.Contains(errs.String(), "owned by") {
		t.Fatalf("%d %q", code, errs.String())
	}
}

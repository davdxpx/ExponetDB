package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
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

func TestConfigOwnedByAnotherUserIsRefused(t *testing.T) {
	configPath, _ := setup(t)
	var out, errs bytes.Buffer
	d := deps{stdout: &out, stderr: &errs, configOwnerUID: os.Getuid() + 1, clock: clock.System{}, host: fakeHost{}}
	if code := run(context.Background(), []string{"status", "--config", configPath}, d); code != 1 || !strings.Contains(errs.String(), "owned by") {
		t.Fatalf("%d %q", code, errs.String())
	}
}

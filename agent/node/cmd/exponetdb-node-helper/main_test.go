package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helper"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperclient"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
)

func testDeps(out, errs *bytes.Buffer, agentUID int) deps {
	return deps{
		stdout: out, stderr: errs, ownerUID: os.Geteuid(),
		clock:  &clock.Fixed{T: time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC), Synced: true},
		runner: helper.ExecRunner{},
		lookupUser: func(name string) (int, int, error) {
			if name != "exponetdb" {
				return 0, 0, errors.New("unknown user")
			}
			return agentUID, os.Getegid(), nil
		},
		listen: helper.Listen,
	}
}

func writeConfig(t *testing.T, dir, agentUser string) string {
	t.Helper()
	cfg, _ := json.Marshal(config.Config{Schema: config.Schema, StateDirectory: filepath.Join(dir, "agent"),
		HelperSocket: filepath.Join(dir, "helper.sock"), AgentUser: agentUser,
		DisabledCapabilities: []string{}, Instances: []config.Instance{}})
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestVersionAndUsage(t *testing.T) {
	var out, errs bytes.Buffer
	d := testDeps(&out, &errs, os.Geteuid()+1)
	if code := run(context.Background(), []string{"version"}, d); code != 0 || strings.TrimSpace(out.String()) != version+" commit "+commit {
		t.Fatalf("version %d %q", code, out.String())
	}
	if code := run(context.Background(), []string{"shell"}, d); code != 2 {
		t.Fatalf("unknown command %d", code)
	}
}

func TestTrustFromAgentState(t *testing.T) {
	dir := t.TempDir()
	agentState := filepath.Join(dir, "agent")
	if err := os.Mkdir(agentState, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := state.Open(agentState, os.Geteuid())
	if err != nil {
		t.Fatal(err)
	}
	root := []byte("a root certificate")
	sum := sha256.Sum256(root)
	key := nodecrypto.B64U(bytes.Repeat([]byte{7}, 32))
	if err := store.SaveState(&state.State{
		Schema: state.StateSchema, InstallationID: "ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z", ServerID: "srv_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z",
		NodeID: "nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z", GatewayURL: "https://gateway.exdb.internal:8443",
		GatewayServerName: "gateway.exdb.internal", RootCertificate: nodecrypto.B64U(root),
		RootFingerprint: "sha256:" + hex.EncodeToString(sum[:]),
		JobKeys:         []state.JobKey{{KeyID: "jobkey_2026_10", PublicKey: key}}, EnrolledAt: "2026-10-07T12:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	var out, errs bytes.Buffer
	d := testDeps(&out, &errs, os.Geteuid()+1)
	trustPath := filepath.Join(dir, "helper-trust.json")
	if code := run(context.Background(), []string{"trust", "--trust", trustPath}, d); code != 2 {
		t.Fatalf("trust without --agent-state: %d", code)
	}
	// A key the operator did not expect: nothing is written.
	if code := run(context.Background(), []string{"trust", "--agent-state", agentState, "--trust", trustPath,
		"--expect-key", "sha256:" + strings.Repeat("0", 64)}, d); code != 1 {
		t.Fatalf("trust with an unexpected key: %d", code)
	}
	if _, err := os.Stat(trustPath); err == nil {
		t.Fatal("a trust was written for an unexpected key")
	}
	pub, _ := nodecrypto.FromB64UOf(key, 32)
	fp := nodecrypto.KeyFingerprint(pub)
	if code := run(context.Background(), []string{"trust", "--agent-state", agentState, "--trust", trustPath,
		"--expect-key", fp}, d); code != 0 {
		t.Fatalf("trust: %d %s", code, errs.String())
	}
	if !strings.Contains(out.String(), fp) {
		t.Fatalf("the fingerprint is not shown: %q", out.String())
	}
	out.Reset()
	if code := run(context.Background(), []string{"trust", "--show", "--trust", trustPath}, d); code != 0 ||
		!strings.Contains(out.String(), "jobkey_2026_10 "+fp) {
		t.Fatalf("show: %d %q", code, out.String())
	}
	// Root never creates anything in the agent's state.
	entries, _ := os.ReadDir(agentState)
	for _, e := range entries {
		if info, _ := e.Info(); info != nil && info.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) {
			t.Fatalf("%s has another owner", e.Name())
		}
	}
	trust, err := helper.LoadTrust(trustPath, os.Geteuid())
	if err != nil || trust.NodeID != "nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z" || len(trust.JobKeys) != 1 || trust.JobKeys[0].PublicKey != key {
		t.Fatalf("trust %+v %v", trust, err)
	}
	if info, _ := os.Stat(trustPath); info.Mode().Perm() != 0o644 {
		t.Fatalf("trust mode %v", info.Mode())
	}
}

func TestServe(t *testing.T) {
	dir := t.TempDir()
	var out, errs bytes.Buffer
	stateDir := filepath.Join(dir, "helper-state")
	args := func(cfg string) []string {
		return []string{"serve", "--config", cfg, "--trust", filepath.Join(dir, "trust.json"), "--state-dir", stateDir}
	}
	if code := run(context.Background(), args(writeConfig(t, dir, "")), testDeps(&out, &errs, os.Geteuid()+1)); code != 1 ||
		!strings.Contains(errs.String(), "agentUser") {
		t.Fatalf("serve without an agent user: %d %q", code, errs.String())
	}
	errs.Reset()
	cfg := writeConfig(t, dir, "exponetdb")
	if code := run(context.Background(), args(cfg), testDeps(&out, &errs, 0)); code != 1 || !strings.Contains(errs.String(), "root") {
		t.Fatalf("serve with a root agent: %d %q", code, errs.String())
	}
	errs.Reset()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int)
	go func() { done <- run(ctx, args(cfg), testDeps(&out, &errs, os.Geteuid()+1)) }()
	socket := filepath.Join(dir, "helper.sock")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if c, err := net.Dial("unix", socket); err == nil {
			_ = c.Close()
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("the helper did not listen: %s", errs.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	// This test's uid is not the agent's: no answer.
	c := &helperclient.Client{Socket: socket}
	callCtx, callCancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, err := c.Call(callCtx, helperproto.OpServiceStatus, canon.Object{})
	callCancel()
	if !errors.Is(err, helperclient.ErrUnavailable) {
		t.Fatalf("another uid was answered: %v", err)
	}
	cancel()
	if code := <-done; code != 0 {
		t.Fatalf("serve exit %d: %s", code, errs.String())
	}
	for _, d := range []string{stateDir, filepath.Join(stateDir, "staging")} {
		if info, err := os.Stat(d); err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("%s: %v %v", d, info, err)
		}
	}
	if _, err := os.Stat(filepath.Join(stateDir, "effects.log")); err != nil {
		t.Fatal(err)
	}
}

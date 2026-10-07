package state

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir, os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func sampleState() *State {
	root := []byte("not really DER, only hashed here")
	sum := sha256.Sum256(root)
	return &State{
		Schema:            StateSchema,
		InstallationID:    "ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z",
		ServerID:          "srv_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z",
		NodeID:            "nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z",
		GatewayURL:        "https://10.8.2.2:7443",
		GatewayServerName: "gateway.exdb.internal",
		RootCertificate:   nodecrypto.B64U(root),
		RootFingerprint:   "sha256:" + hex.EncodeToString(sum[:]),
		JobKeys:           []JobKey{{KeyID: "jobkey_2026_10", PublicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}},
		EnrolledAt:        "2026-10-07T12:00:00Z",
	}
}

func sampleIdentity() *Identity {
	k := nodecrypto.B64U(bytes.Repeat([]byte{7}, 32))
	return &Identity{
		Schema:               IdentitySchema,
		TLSSeed:              k,
		NodeSigningSeed:      k,
		NodeEncryptionSecret: k,
		CertificateChain:     []string{"MIIB", "MIIC"},
		CertificateExpiresAt: "2026-10-10T12:00:00Z",
	}
}

func TestRoundTripAndPermissions(t *testing.T) {
	s := newStore(t)
	if _, err := s.LoadState(); !errors.Is(err, ErrNotEnrolled) {
		t.Fatalf("empty store: %v", err)
	}
	st := sampleState()
	if err := s.SaveState(st); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveIdentity(sampleIdentity()); err != nil {
		t.Fatal(err)
	}
	got, err := s.LoadState()
	if err != nil || got.NodeID != st.NodeID || len(got.Trusted()) != 1 {
		t.Fatalf("%+v, %v", got, err)
	}
	if _, err := s.LoadIdentity(); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{s.Path("state.json"), s.Path(IdentityDir, "keys.json")} {
		info, err := os.Stat(p)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v %v", p, info.Mode(), err)
		}
	}
}

func TestTamperingIsCorruption(t *testing.T) {
	s := newStore(t)
	if err := s.SaveState(sampleState()); err != nil {
		t.Fatal(err)
	}
	path := s.Path("state.json")
	data, _ := os.ReadFile(path)
	for name, edit := range map[string][]byte{
		"changed value":  bytes.Replace(data, []byte("7443"), []byte("7444"), 1),
		"truncated":      data[:len(data)/2],
		"extra member":   bytes.Replace(data, []byte(`"content":{`), []byte(`"content":{"x":1,`), 1),
		"empty":          {},
		"other checksum": bytes.Replace(data, []byte(`"checksum":"sha256:`), []byte(`"checksum":"sha256:0`), 1),
	} {
		if err := os.WriteFile(path, edit, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := s.LoadState(); !errors.Is(err, ErrCorrupt) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoadState(); !errors.Is(err, ErrCorrupt) {
		t.Errorf("world-readable state: %v", err)
	}
}

func TestValidateRefuses(t *testing.T) {
	for name, edit := range map[string]func(*State){
		"wrong node id": func(s *State) { s.NodeID = "srv_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z" },
		"gateway 443":   func(s *State) { s.GatewayURL = "https://10.8.2.2:443" },
		"no job keys":   func(s *State) { s.JobKeys = nil },
		"four job keys": func(s *State) { s.JobKeys = append(s.JobKeys, s.JobKeys[0], s.JobKeys[0], s.JobKeys[0]) },
		"root mismatch": func(s *State) { s.RootFingerprint = "sha256:" + hex.EncodeToString(make([]byte, 32)) },
		"bad issuedAt":  func(s *State) { s.HighestIssuedAt = "2026-02-30T00:00:00Z" },
		"short job key": func(s *State) { s.JobKeys[0].PublicKey = "AQ" },
	} {
		st := sampleState()
		edit(st)
		if err := st.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestOpenRefusesAnOpenDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir, os.Getuid()); err == nil {
		t.Fatal("accepted a group-readable state directory")
	}
}

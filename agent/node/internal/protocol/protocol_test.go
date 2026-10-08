package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// fixturesDir finds tooling/fixtures/node-protocol by walking up from the
// package directory.
func fixturesDir(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		candidate := filepath.Join(dir, "tooling", "fixtures", "node-protocol")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("tooling/fixtures/node-protocol not found")
		}
		dir = parent
	}
}

// TestFixturesRoundTrip decodes every protocol fixture that the TypeScript
// contract tests validate into the generated Go type, refusing unknown
// fields, and checks that encoding it again gives the same canonical JSON.
// Together the two tests show that the Zod contract and the generated Go
// types agree on every field.
func TestFixturesRoundTrip(t *testing.T) {
	dir := fixturesDir(t)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		name := strings.SplitN(e.Name(), ".", 2)[0]
		seen[name] = true
		t.Run(e.Name(), func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				t.Fatal(err)
			}
			msg, ok := NewMessage(name)
			if !ok {
				t.Fatalf("no generated type for message %s", name)
			}
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.DisallowUnknownFields()
			if err := dec.Decode(msg); err != nil {
				t.Fatalf("strict decode: %v", err)
			}
			encoded, err := json.Marshal(msg)
			if err != nil {
				t.Fatal(err)
			}
			want := canonical(t, raw)
			got := canonical(t, encoded)
			if want != got {
				t.Fatalf("round trip changed the message\nwant %s\ngot  %s", want, got)
			}
		})
	}
	for _, name := range []string{"EnrollRequest", "EnrollResponse", "RenewRequest", "RenewResponse", "HelloRequest", "HelloResponse", "HeartbeatRequest", "HeartbeatResponse", "ClaimRequest", "ClaimResponse", "JobEnvelope", "JobStartRequest", "JobStartResponse", "JobProgressRequest", "JobProgressResponse", "JobCompleteRequest", "JobCompleteResponse", "ProtocolError"} {
		if !seen[name] {
			t.Errorf("no fixture for message %s", name)
		}
	}
}

func TestUnknownFieldsAreRefused(t *testing.T) {
	msg, _ := NewMessage("ClaimRequest")
	dec := json.NewDecoder(strings.NewReader(`{"nodeId":"nod_01JB2Z0000000000000000000N","waitSeconds":25,"exec":"rm -rf /"}`))
	dec.DisallowUnknownFields()
	if err := dec.Decode(msg); err == nil {
		t.Fatal("an unknown field was accepted")
	}
}

func canonical(t *testing.T, raw []byte) string {
	t.Helper()
	v, err := canon.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	out, err := canon.Canonicalize(v)
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	return string(out)
}

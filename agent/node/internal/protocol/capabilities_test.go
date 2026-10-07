package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// repoDir finds a directory below the repository root by walking up.
func repoDir(t *testing.T, parts ...string) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		candidate := filepath.Join(append([]string{dir}, parts...)...)
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("%s not found", filepath.Join(parts...))
		}
		dir = parent
	}
}

// TestCapabilityFixturesRoundTrip decodes every capability argument and
// result fixture strictly into its generated type and checks that encoding it
// again gives the same canonical JSON, as the TypeScript catalog tests
// validate the same files against the Zod schemas.
func TestCapabilityFixturesRoundTrip(t *testing.T) {
	dir := repoDir(t, "tooling", "fixtures", "node-capabilities")
	for _, key := range CapabilityKeys {
		for _, part := range []string{"args", "result"} {
			name := key + "." + part + ".json"
			t.Run(name, func(t *testing.T) {
				raw, err := os.ReadFile(filepath.Join(dir, name))
				if err != nil {
					t.Fatal(err)
				}
				var msg any
				var ok bool
				if part == "args" {
					msg, ok = NewCapabilityArgs(key)
				} else {
					msg, ok = NewCapabilityResult(key)
				}
				if !ok {
					t.Fatalf("no generated type for %s %s", key, part)
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
				if want, got := canonical(t, raw), canonical(t, encoded); want != got {
					t.Fatalf("round trip changed the value\nwant %s\ngot  %s", want, got)
				}
			})
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2*len(CapabilityKeys) {
		t.Errorf("%d fixture files for %d capabilities", len(entries), len(CapabilityKeys))
	}
	if _, ok := NewCapabilityArgs("shell.exec@1"); ok {
		t.Error("a capability outside the catalog has a type")
	}
}

// TestPatternsAreRE2 compiles every pattern of the node protocol schema with
// Go's regexp (RE2): the agent validates arguments with the same patterns, so
// none may need backtracking features such as lookahead.
func TestPatternsAreRE2(t *testing.T) {
	path := filepath.Join(repoDir(t, "packages", "contracts", "generated", "jsonschema"), "node-protocol.v1.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	count := 0
	var walk func(v any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, inner := range x {
				if p, isString := inner.(string); isString && k == "pattern" {
					count++
					if _, err := regexp.Compile(p); err != nil {
						t.Errorf("pattern %q: %v", p, err)
					}
					if strings.Contains(p, "(?=") || strings.Contains(p, "(?!") {
						t.Errorf("pattern %q uses lookaround", p)
					}
				}
				walk(inner)
			}
		case []any:
			for _, inner := range x {
				walk(inner)
			}
		}
	}
	walk(doc)
	if count < 50 {
		t.Fatalf("only %d patterns found", count)
	}
}

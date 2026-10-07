package schema

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
)

func fixturesDir(t *testing.T, name string) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		candidate := filepath.Join(dir, "tooling", "fixtures", name)
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("tooling/fixtures/%s not found", name)
		}
		dir = parent
	}
}

func read(t *testing.T, path string) canon.Value {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	v, err := canon.Parse(data)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return v
}

func validator(t *testing.T) *Validator {
	t.Helper()
	v, err := Protocol()
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestValidCapabilityFixtures(t *testing.T) {
	v := validator(t)
	dir := fixturesDir(t, "node-capabilities")
	for _, key := range protocol.CapabilityKeys {
		if err := v.ValidateArgs(key, read(t, filepath.Join(dir, key+".args.json"))); err != nil {
			t.Errorf("%s args: %v", key, err)
		}
		if err := v.ValidateResult(key, read(t, filepath.Join(dir, key+".result.json"))); err != nil {
			t.Errorf("%s result: %v", key, err)
		}
	}
	if err := v.ValidateArgs("shell.exec@1", canon.Object{}); err == nil {
		t.Error("validated a capability outside the catalog")
	}
}

// TestInvalidCapabilityFixtures: every shared invalid fixture is refused, as
// the TypeScript contract tests refuse it.
func TestInvalidCapabilityFixtures(t *testing.T) {
	v := validator(t)
	dir := fixturesDir(t, "node-capabilities-invalid")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) < 20 {
		t.Fatalf("%d invalid fixtures, %v", len(entries), err)
	}
	for _, e := range entries {
		key := e.Name()[:strings.Index(e.Name(), "@")+2]
		if err := v.ValidateArgs(key, read(t, filepath.Join(dir, e.Name()))); err == nil {
			t.Errorf("%s: accepted", e.Name())
		}
	}
}

func TestProtocolMessageFixtures(t *testing.T) {
	v := validator(t)
	dir := fixturesDir(t, "node-protocol")
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		name := strings.SplitN(e.Name(), ".", 2)[0]
		ref, ok := v.MessageRef(name)
		if !ok {
			t.Fatalf("%s: no message %s", e.Name(), name)
		}
		value := read(t, filepath.Join(dir, e.Name()))
		if err := v.Validate(ref, value); err != nil {
			t.Errorf("%s: %v", e.Name(), err)
		}
		o := value.(canon.Object)
		extended := append(append(canon.Object{}, o...), canon.Member{Name: "unexpected", Value: canon.Bool(true)})
		if err := v.Validate(ref, extended); err == nil {
			t.Errorf("%s: accepted an unknown member", e.Name())
		}
	}
}

func TestUnsupportedKeywordIsRefused(t *testing.T) {
	doc := `{"$defs":{"A":{"type":"string","pattern":"^a$","if":{"type":"string"}}}}`
	if _, err := New([]byte(doc)); err == nil || !strings.Contains(err.Error(), `"if"`) {
		t.Fatalf("loaded a schema with an unsupported keyword: %v", err)
	}
	doc = `{"$defs":{"A":{"type":"string","pattern":"^(?=a)$"}}}`
	if _, err := New([]byte(doc)); err == nil {
		t.Fatal("loaded a non-RE2 pattern")
	}
	doc = `{"$defs":{"A":{"$ref":"#/$defs/B"}}}`
	if _, err := New([]byte(doc)); err == nil {
		t.Fatal("loaded a dangling reference")
	}
}

func TestTypesAndBounds(t *testing.T) {
	doc := `{"$defs":{"N":{"type":"object","properties":{
	  "i":{"type":"integer","minimum":1,"maximum":3},
	  "s":{"type":"string","minLength":2,"maxLength":3},
	  "a":{"type":"array","items":{"type":"boolean"},"minItems":1,"maxItems":2},
	  "e":{"type":"string","enum":["x","y"]},
	  "c":{"type":"string","const":"k"},
	  "n":{"anyOf":[{"type":"string"},{"type":"null"}]}
	},"required":["i"],"additionalProperties":false}}}`
	v, err := New([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	for value, ok := range map[string]bool{
		`{"i":2}`:              true,
		`{"i":2.5}`:            false,
		`{"i":0}`:              false,
		`{"i":4}`:              false,
		`{}`:                   false,
		`{"i":1,"s":"ab"}`:     true,
		`{"i":1,"s":"a"}`:      false,
		`{"i":1,"s":"äöüß"}`:   false,
		`{"i":1,"s":"äöü"}`:    true,
		`{"i":1,"a":[]}`:       false,
		`{"i":1,"a":[true,1]}`: false,
		`{"i":1,"e":"z"}`:      false,
		`{"i":1,"c":"k"}`:      true,
		`{"i":1,"n":null}`:     true,
		`{"i":1,"n":1}`:        false,
		`{"i":1,"x":1}`:        false,
	} {
		parsed, err := canon.Parse([]byte(value))
		if err != nil {
			t.Fatal(err)
		}
		if err := v.Validate("#/$defs/N", parsed); (err == nil) != ok {
			t.Errorf("%s: %v", value, err)
		}
	}
}

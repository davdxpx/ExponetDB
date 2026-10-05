package conformance

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"unicode/utf8"
)

// goldenDir walks up from the test's working directory until it finds a
// directory that contains tooling/golden.
func goldenDir(t *testing.T) string {
	t.Helper()
	start, err := os.Getwd()
	if err != nil {
		t.Fatalf("working directory: %v", err)
	}
	for dir := start; ; {
		candidate := filepath.Join(dir, "tooling", "golden")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("no tooling/golden directory above %s", start)
		}
		dir = parent
	}
}

// goldenFile is the envelope shared by every golden file.
type goldenFile[V any] struct {
	Contract      string `json:"contract"`
	Specification string `json:"specification"`
	Notes         string `json:"notes"`
	Vectors       []V    `json:"vectors"`
}

// loadVectors decodes a golden file. Unknown fields are an error, so a vector
// that grows a new field cannot be silently ignored by these tests.
func loadVectors[V any](t *testing.T, name string) []V {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(goldenDir(t), name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if !utf8.Valid(data) {
		t.Fatalf("%s is not valid UTF-8", name)
	}
	var file goldenFile[V]
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&file); err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
	if len(file.Vectors) == 0 {
		t.Fatalf("%s has no vectors", name)
	}
	return file.Vectors
}

// checkUniqueIDs fails when a vector id is empty or repeated.
func checkUniqueIDs(t *testing.T, ids []string) {
	t.Helper()
	seen := map[string]bool{}
	for _, id := range ids {
		if id == "" || seen[id] {
			t.Fatalf("vector id %q is empty or not unique", id)
		}
		seen[id] = true
	}
}

// errorCode returns the Code of a conformance *Error, or "" for nil or any
// other error.
func errorCode(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

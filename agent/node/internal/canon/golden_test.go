package canon

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
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

// loadGolden decodes a golden file into v. Unknown fields are an error, so a
// vector that grows a new field cannot be silently ignored by this test.
func loadGolden(t *testing.T, name string, v any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(goldenDir(t), name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if !utf8.Valid(data) {
		t.Fatalf("%s is not valid UTF-8", name)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
}

type jcsFile struct {
	Contract      string      `json:"contract"`
	Specification string      `json:"specification"`
	Notes         string      `json:"notes"`
	Vectors       []jcsVector `json:"vectors"`
}

type jcsVector struct {
	ID            string  `json:"id"`
	Description   string  `json:"description"`
	Input         *string `json:"input"`
	Expected      *string `json:"expected"`
	SHA256        string  `json:"sha256"`
	ExpectedError string  `json:"expectedError"`
}

func TestGoldenJCS(t *testing.T) {
	var file jcsFile
	loadGolden(t, "jcs.json", &file)
	if len(file.Vectors) == 0 {
		t.Fatal("jcs.json has no vectors")
	}
	seen := map[string]bool{}
	for _, v := range file.Vectors {
		if v.ID == "" || seen[v.ID] {
			t.Fatalf("vector id %q is empty or not unique", v.ID)
		}
		seen[v.ID] = true
		t.Run(v.ID, func(t *testing.T) {
			if v.Input == nil {
				t.Fatal("vector has no input")
			}
			if (v.Expected == nil) == (v.ExpectedError == "") {
				t.Fatal("vector must have exactly one of expected and expectedError")
			}
			got, err := Transform([]byte(*v.Input))
			if v.ExpectedError != "" {
				var cerr *Error
				if !errors.As(err, &cerr) {
					t.Fatalf("got %q, %v; want error %s", got, err, v.ExpectedError)
				}
				if cerr.Code != v.ExpectedError {
					t.Fatalf("got error code %s (%v); want %s", cerr.Code, cerr, v.ExpectedError)
				}
				return
			}
			// The vector must be internally consistent before anything else.
			sum := sha256.Sum256([]byte(*v.Expected))
			if hex.EncodeToString(sum[:]) != v.SHA256 {
				t.Fatalf("vector inconsistent: sha256(expected) = %x, vector says %s", sum, v.SHA256)
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if string(got) != *v.Expected {
				t.Fatalf("canonical text mismatch\n got: %s\nwant: %s", got, *v.Expected)
			}
			gotSum := sha256.Sum256(got)
			if hex.EncodeToString(gotSum[:]) != v.SHA256 {
				t.Fatalf("sha256 mismatch: got %x, want %s", gotSum, v.SHA256)
			}
			// Canonical text is a fixed point of Transform.
			again, err := Transform(got)
			if err != nil || !bytes.Equal(again, got) {
				t.Fatalf("canonical text is not a fixed point: %q, %v", again, err)
			}
		})
	}
	t.Logf("jcs.json: %d vectors", len(file.Vectors))
}

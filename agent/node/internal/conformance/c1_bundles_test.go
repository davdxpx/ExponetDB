package conformance

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/davdxpx/exponetdb/agent/node/internal/canon"
)

type bundleVector struct {
	ID              string            `json:"id"`
	Description     string            `json:"description"`
	Manifest        json.RawMessage   `json:"manifest"`
	ProjectDefaults json.RawMessage   `json:"projectDefaults"`
	Files           map[string]string `json:"files"`
	Expected        *bundleExpected   `json:"expected"`
	ExpectedError   *bundleError      `json:"expectedError"`
	SameDigestsAs   string            `json:"sameDigestsAs"`
}

type bundleExpected struct {
	ApplyProjection    string             `json:"applyProjection"`
	VerifyProjection   string             `json:"verifyProjection"`
	RollbackProjection string             `json:"rollbackProjection"`
	ExecutableText     map[string]*string `json:"executableText"`
	Checksum           string             `json:"checksum"`
	VerifyDigest       string             `json:"verifyDigest"`
	RollbackDigest     string             `json:"rollbackDigest"`
	BundleDigest       string             `json:"bundleDigest"`
	SourceDigest       string             `json:"sourceDigest"`
}

type bundleError struct {
	Code string `json:"code"`
	File string `json:"file"`
}

// bundleInput turns a vector into a Bundle. The manifest and the project
// defaults go through canon.Parse, exactly as raw JSON.
func bundleInput(t *testing.T, v bundleVector) Bundle {
	t.Helper()
	if v.Manifest == nil || v.ProjectDefaults == nil || v.Files == nil {
		t.Fatal("vector needs manifest, projectDefaults and files")
	}
	manifest, err := canon.Parse(v.Manifest)
	if err != nil {
		t.Fatalf("manifest: %v", err)
	}
	defaults, err := canon.Parse(v.ProjectDefaults)
	if err != nil {
		t.Fatalf("projectDefaults: %v", err)
	}
	files := map[string][]byte{}
	for name, text := range v.Files {
		files[name] = []byte(text)
	}
	return Bundle{Manifest: manifest, ProjectDefaults: defaults, Files: files}
}

// digestSet is the set of values that sameDigestsAs relates.
type digestSet struct {
	checksum, verify, rollback, bundle, source string
}

func TestGoldenC1Bundles(t *testing.T) {
	vectors := loadVectors[bundleVector](t, "c1-bundles.json")
	ids := make([]string, len(vectors))
	for i, v := range vectors {
		ids[i] = v.ID
	}
	checkUniqueIDs(t, ids)

	computed := map[string]digestSet{}
	expected := map[string]digestSet{}
	for _, v := range vectors {
		t.Run(v.ID, func(t *testing.T) {
			if (v.Expected == nil) == (v.ExpectedError == nil) {
				t.Fatal("vector must have exactly one of expected and expectedError")
			}
			got, err := ComputeBundleDigests(bundleInput(t, v))
			if v.ExpectedError != nil {
				if v.ExpectedError.Code == "" {
					t.Fatal("expectedError has no code")
				}
				var gotFile string
				var e *Error
				if errors.As(err, &e) {
					gotFile = e.File
				}
				if errorCode(err) != v.ExpectedError.Code || gotFile != v.ExpectedError.File {
					t.Fatalf("got %v; want code %s file %q", err, v.ExpectedError.Code, v.ExpectedError.File)
				}
				return
			}
			want := v.Expected
			expected[v.ID] = digestSet{want.Checksum, want.VerifyDigest, want.RollbackDigest, want.BundleDigest, want.SourceDigest}
			checkVectorSelfConsistency(t, want)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			check := func(name, got, want string) {
				t.Helper()
				if got != want {
					t.Errorf("%s mismatch\n got: %s\nwant: %s", name, got, want)
				}
			}
			check("applyProjection", string(got.ApplyProjection), want.ApplyProjection)
			check("verifyProjection", string(got.VerifyProjection), want.VerifyProjection)
			check("rollbackProjection", string(got.RollbackProjection), want.RollbackProjection)
			for _, name := range []string{FileUp, FileVerify, FileDown} {
				wantText, listed := want.ExecutableText[name]
				if !listed {
					t.Fatalf("expected.executableText has no entry for %s", name)
				}
				gotText, present := got.ExecutableText[name]
				switch {
				case wantText == nil && present:
					t.Errorf("executableText[%s] = %q; want null (absent file)", name, gotText)
				case wantText != nil && !present:
					t.Errorf("executableText[%s] is absent; want %q", name, *wantText)
				case wantText != nil:
					check("executableText["+name+"]", string(gotText), *wantText)
				}
			}
			if len(want.ExecutableText) != 3 || len(got.ExecutableText) > 3 {
				t.Errorf("executableText must cover exactly up.sql, verify.sql and down.sql")
			}
			check("checksum", got.Checksum, want.Checksum)
			check("verifyDigest", got.VerifyDigest, want.VerifyDigest)
			check("rollbackDigest", got.RollbackDigest, want.RollbackDigest)
			check("bundleDigest", got.BundleDigest, want.BundleDigest)
			check("sourceDigest", got.SourceDigest, want.SourceDigest)
			computed[v.ID] = digestSet{got.Checksum, got.VerifyDigest, got.RollbackDigest, got.BundleDigest, got.SourceDigest}
		})
	}

	// sameDigestsAs: the two vectors have identical digests, both as stated by
	// the vectors and as computed.
	relations := 0
	for _, v := range vectors {
		if v.SameDigestsAs == "" {
			continue
		}
		relations++
		t.Run(v.ID+"/sameDigestsAs/"+v.SameDigestsAs, func(t *testing.T) {
			other, ok := expected[v.SameDigestsAs]
			if !ok {
				t.Fatalf("%s is not a success vector of this file", v.SameDigestsAs)
			}
			if expected[v.ID] != other {
				t.Errorf("vector inconsistent: expected digests of %s and %s differ", v.ID, v.SameDigestsAs)
			}
			a, okA := computed[v.ID]
			b, okB := computed[v.SameDigestsAs]
			if !okA || !okB {
				t.Fatalf("digests of %s or %s were not computed", v.ID, v.SameDigestsAs)
			}
			if a != b {
				t.Errorf("computed digests differ:\n%s: %+v\n%s: %+v", v.ID, a, v.SameDigestsAs, b)
			}
		})
	}
	t.Logf("c1-bundles.json: %d vectors, %d sameDigestsAs relations", len(vectors), relations)
}

// checkVectorSelfConsistency re-derives the digests of a vector from its own
// expected projections and executable texts, as the golden README describes,
// so that a mismatch can be attributed either to the vector or to the
// projection and c1 code under test.
func checkVectorSelfConsistency(t *testing.T, want *bundleExpected) {
	t.Helper()
	text := func(name string) ([]byte, bool) {
		p := want.ExecutableText[name]
		if p == nil {
			return nil, false
		}
		return []byte(*p), true
	}
	up, upPresent := text(FileUp)
	if !upPresent {
		t.Fatal("vector inconsistent: up.sql executable text is null")
	}
	verify, verifyPresent := text(FileVerify)
	down, downPresent := text(FileDown)
	checksum := ApplyChecksum([]byte(want.ApplyProjection), up)
	verifyDigest := VerifyDigest([]byte(want.VerifyProjection), verify, verifyPresent)
	rollbackDigest := RollbackDigest([]byte(want.RollbackProjection), down, downPresent)
	bundleDigest := BundleDigest(want.Checksum, want.VerifyDigest, want.RollbackDigest)
	for _, c := range []struct{ name, derived, stated string }{
		{"checksum", checksum, want.Checksum},
		{"verifyDigest", verifyDigest, want.VerifyDigest},
		{"rollbackDigest", rollbackDigest, want.RollbackDigest},
		{"bundleDigest", bundleDigest, want.BundleDigest},
	} {
		if c.derived != c.stated {
			t.Errorf("vector inconsistent: %s derived from the expected texts is %s, vector says %s", c.name, c.derived, c.stated)
		}
	}
	// The projections themselves must be canonical JSON.
	for name, p := range map[string]string{
		"applyProjection":    want.ApplyProjection,
		"verifyProjection":   want.VerifyProjection,
		"rollbackProjection": want.RollbackProjection,
	} {
		if c, err := canon.Transform([]byte(p)); err != nil || string(c) != p {
			t.Errorf("vector inconsistent: %s is not JCS: %q, %v", name, c, err)
		}
	}
}

package conformance

import (
	"testing"

	"github.com/davdxpx/exponetdb/agent/node/internal/canon"
)

func TestParseDurationMillis(t *testing.T) {
	valid := map[string]int64{
		"1ms":         1,
		"0s":          0, // grammatical; refused by the bounds, not the grammar
		"5s":          5000,
		"5000ms":      5000,
		"10m":         600000,
		"1h30m":       5400000,
		"1h2m3s4ms":   3723004,
		"6h":          21600000,
		"1m5ms":       60005,
		"999999999h":  999999999 * 3600000,
		"999999999ms": 999999999,
		"0h0m0s1ms":   1,
		"90s":         90000,
		"250ms":       250,
		"1h0ms":       3600000,
		"123456789s":  123456789000,
		"1h1m1s1ms":   3661001,
		"100000000m":  6000000000000,
		"0ms":         0,
	}
	for in, want := range valid {
		got, ok := ParseDurationMillis(in)
		if !ok || got != want {
			t.Errorf("ParseDurationMillis(%q) = %d, %v; want %d", in, got, ok, want)
		}
	}
	for _, in := range []string{
		"", "s", "ms", "5", "5 s", " 5s", "5s ", "1.5s", "-1s", "+1s", "05s", "00s",
		"5s1m", "1s1s", "1ms1s", "1m1h", "PT5S", "5S", "5M", "1d", "1us", "1000000000ms",
		"15 minutes", "1h 30m", "1hm", "5msx", "1h30", "٥s",
	} {
		if got, ok := ParseDurationMillis(in); ok {
			t.Errorf("ParseDurationMillis(%q) = %d; want refusal", in, got)
		}
	}
	for in, code := range map[string]string{"0s": CodeDurationOutOfRange, "6h1ms": CodeDurationOutOfRange, "6h": "", "1ms": "", "1.5s": CodeInvalidDuration} {
		_, err := TimeoutMillis(in)
		if errorCode(err) != code {
			t.Errorf("TimeoutMillis(%q) = %v; want %q", in, err, code)
		}
	}
}

func mustParse(t *testing.T, s string) canon.Value {
	t.Helper()
	v, err := canon.Parse([]byte(s))
	if err != nil {
		t.Fatalf("parse %s: %v", s, err)
	}
	return v
}

const minimalManifest = `{
  "schema": "exponetdb.migration/v1",
  "id": "01JB2Z6G8M4Q7R9T1V3W5X7Y9Z",
  "dependsOn": [],
  "execution": {"transactional": true, "role": "owner", "searchPath": ["public"]},
  "compatibility": {"declared": "additive"},
  "verification": {"expectations": "auto", "runtimeChecks": "none"}
}`

func TestComputeBundleDigestsMinimal(t *testing.T) {
	got, err := ComputeBundleDigests(Bundle{
		Manifest: mustParse(t, minimalManifest),
		Files:    map[string][]byte{FileUp: []byte("SELECT 1;\r\n")},
	})
	if err != nil {
		t.Fatal(err)
	}
	wantP := `{"compatibility":{"declared":"additive"},"dependsOn":[],"execution":{"lockTimeout":5000,"role":"owner","searchPath":["public"],"statementTimeout":900000,"transactional":true},"id":"01JB2Z6G8M4Q7R9T1V3W5X7Y9Z","requires":{"extensions":[],"postgres":null},"schema":"exponetdb.migration/v1"}`
	if string(got.ApplyProjection) != wantP {
		t.Errorf("P = %s\nwant %s", got.ApplyProjection, wantP)
	}
	if string(got.RollbackProjection) != `{"rollback":null}` {
		t.Errorf("R = %s", got.RollbackProjection)
	}
	if len(got.ExecutableText) != 1 || string(got.ExecutableText[FileUp]) != "SELECT 1;" {
		t.Errorf("executable text = %q", got.ExecutableText)
	}
	if got.SourceDigest != SourceDigest([]byte("SELECT 1;\n")) {
		t.Errorf("source digest %s does not hash the normalized bytes", got.SourceDigest)
	}
}

func TestComputeBundleDigestsRefusals(t *testing.T) {
	up := map[string][]byte{FileUp: []byte("SELECT 1;")}
	cases := []struct {
		name     string
		manifest string
		defaults string
		files    map[string][]byte
		code     string
		file     string
	}{
		{"manifest not an object", `[]`, "", up, CodeInvalidManifest, ""},
		{"missing up.sql", minimalManifest, "", map[string][]byte{}, CodeMissingFile, FileUp},
		{"defaults not an object", minimalManifest, `[]`, up, CodeInvalidProjectDefaults, ""},
		{"defaults timeout not a string", minimalManifest, `{"lockTimeout": 5}`, up, CodeInvalidDuration, ""},
		{"defaults role not a string", minimalManifest, `{"role": null}`, up, CodeInvalidProjectDefaults, ""},
		{"defaults checked before the manifest", `[]`, `{"statementTimeout": "7h"}`, up, CodeDurationOutOfRange, ""},
		{"missing schema", `{"id": "x"}`, "", up, CodeInvalidManifest, ""},
		{"null role is not unset", `{"schema": "s", "id": "i", "dependsOn": [], "execution": {"transactional": true, "role": null}}`, `{"role": "owner"}`, up, CodeInvalidManifest, ""},
		{"duplicate extension", `{"schema": "s", "id": "i", "dependsOn": [], "execution": {"transactional": true, "role": "r", "searchPath": []}, "requires": {"extensions": [{"name": "a"}, {"name": "a"}]}, "compatibility": {"declared": "additive"}}`, "", up, CodeInvalidManifest, ""},
		{"projections before files", `{"schema": "s"}`, "", map[string][]byte{FileUp: []byte("'")}, CodeInvalidManifest, ""},
		{"up.sql before verify.sql", minimalManifest, "", map[string][]byte{FileUp: []byte("'"), FileVerify: []byte("\x00")}, CodeUnterminatedString, FileUp},
		{"verify.sql before down.sql", minimalManifest, "", map[string][]byte{FileUp: []byte("x"), FileVerify: []byte("\"")}, CodeUnterminatedQuotedIdentifier, FileVerify},
	}
	for _, c := range cases {
		b := Bundle{Manifest: mustParse(t, c.manifest), Files: c.files}
		if c.defaults != "" {
			b.ProjectDefaults = mustParse(t, c.defaults)
		}
		_, err := ComputeBundleDigests(b)
		e, ok := err.(*Error)
		if !ok || e.Code != c.code || e.File != c.file {
			t.Errorf("%s: got %v; want %s %q", c.name, err, c.code, c.file)
		}
	}
	// A hand-built manifest with duplicate member names is refused.
	dup := canon.Object{{Name: "schema", Value: canon.String("a")}, {Name: "schema", Value: canon.String("b")}}
	if _, err := ComputeBundleDigests(Bundle{Manifest: dup, Files: up}); errorCode(err) != CodeInvalidManifest {
		t.Errorf("duplicate members: got %v", err)
	}
}

func TestFrame(t *testing.T) {
	if got := string(Frame("up.sql", nil)); got != "up.sql\n0\n\n" {
		t.Errorf("empty frame = %q", got)
	}
	if got := string(Frame("x", []byte("é"))); got != "x\n2\né\n" {
		t.Errorf("frame length must count bytes: %q", got)
	}
}

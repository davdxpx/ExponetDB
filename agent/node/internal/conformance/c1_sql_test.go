package conformance

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
)

type c1SQLVector struct {
	ID            string  `json:"id"`
	Description   string  `json:"description"`
	Input         *string `json:"input"`
	InputHex      *string `json:"inputHex"`
	Expected      *string `json:"expected"`
	ExpectedError string  `json:"expectedError"`
}

// input returns the raw bytes of a vector: the UTF-8 encoding of input, or
// the decoded inputHex.
func (v c1SQLVector) input(t *testing.T) []byte {
	t.Helper()
	switch {
	case v.Input != nil && v.InputHex == nil:
		return []byte(*v.Input)
	case v.Input == nil && v.InputHex != nil:
		b, err := hex.DecodeString(*v.InputHex)
		if err != nil {
			t.Fatalf("inputHex: %v", err)
		}
		return b
	}
	t.Fatal("vector needs exactly one of input and inputHex")
	return nil
}

func loadC1SQLVectors(t *testing.T) []c1SQLVector {
	vectors := loadVectors[c1SQLVector](t, "c1-sql.json")
	ids := make([]string, len(vectors))
	for i, v := range vectors {
		ids[i] = v.ID
	}
	checkUniqueIDs(t, ids)
	return vectors
}

func TestGoldenC1SQL(t *testing.T) {
	vectors := loadC1SQLVectors(t)
	for _, v := range vectors {
		t.Run(v.ID, func(t *testing.T) {
			if (v.Expected == nil) == (v.ExpectedError == "") {
				t.Fatal("vector must have exactly one of expected and expectedError")
			}
			in := v.input(t)
			got, err := ExecutableText(in)
			if v.ExpectedError != "" {
				if code := errorCode(err); code != v.ExpectedError {
					t.Fatalf("ExecutableText(%q) = %q, %v; want error %s", in, got, err, v.ExpectedError)
				}
				return
			}
			if err != nil {
				t.Fatalf("ExecutableText(%q): unexpected error %v", in, err)
			}
			if string(got) != *v.Expected {
				t.Fatalf("executable text mismatch\n  in: %q\n got: %q\nwant: %q", in, got, *v.Expected)
			}
		})
	}
	t.Logf("c1-sql.json: %d vectors", len(vectors))
}

// TestExecutableTextIsIdempotent checks a property that follows from N4 and
// N5 (it is not stated by them): executable text contains no comments, no
// separator other than single spaces and no leading or trailing separator,
// and every token is copied verbatim, so canonicalizing it again changes
// nothing.
func TestExecutableTextIsIdempotent(t *testing.T) {
	for _, v := range loadC1SQLVectors(t) {
		if v.Expected == nil {
			continue
		}
		t.Run(v.ID, func(t *testing.T) {
			again, err := ExecutableText([]byte(*v.Expected))
			if err != nil || string(again) != *v.Expected {
				t.Fatalf("not a fixed point: %q -> %q, %v", *v.Expected, again, err)
			}
		})
	}
}

func TestNormalizeSource(t *testing.T) {
	got, err := NormalizeSource([]byte("a\r\nb\rc\r\r\nd\n"))
	if err != nil || string(got) != "a\nb\nc\n\nd\n" {
		t.Fatalf("got %q, %v", got, err)
	}
	for in, code := range map[string]string{
		"\xef\xbb\xbfx":        CodeBOM,
		"x\x00":                CodeNUL,
		"\xed\xbf\xbf":         CodeInvalidUTF8,
		"\xf8\x88\x80\x80\x80": CodeInvalidUTF8,
	} {
		if _, err := NormalizeSource([]byte(in)); errorCode(err) != code {
			t.Errorf("NormalizeSource(%q) = %v; want %s", in, err, code)
		}
	}
	if got, err := NormalizeSource([]byte("x\xef\xbb\xbf")); err != nil || !bytes.Equal(got, []byte("x\xef\xbb\xbf")) {
		t.Fatalf("U+FEFF after the start is ordinary: %q, %v", got, err)
	}
}

func TestExecutableTextEdgeCases(t *testing.T) {
	cases := []struct {
		in, want, code string
	}{
		{in: "''", want: "''"},
		{in: "E''", want: "E''"},
		{in: "a\n", want: "a"},
		{in: "$", want: "$"},
		{in: "$$$$", want: "$$$$"},
		{in: "$a", want: "$a"},
		{in: "$a$$a$", want: "$a$$a$"},
		{in: "a-- c\n-b", want: "a -b"},
		{in: "'a' -- c", want: "'a'"},
		{in: "'a'\n-- c\n'b'", want: "'a'\n-- c\n'b'"},
		{in: "'a' /**/\n'b'", want: "'a' 'b'"},
		{in: "'a'\n\n", want: "'a'"},
		{in: "x/* /* */ */y", want: "x y"},
		{in: "u&'x'", want: "u&'x'"},
		{in: "u&\"x\"\"y\"", want: "u&\"x\"\"y\""},
		{in: "U&", want: "U&"},
		{in: "E", want: "E"},
		{in: "\"\"", want: "\"\""},
		{in: "E'\\", code: CodeUnterminatedString},
		{in: "'a'\n'", code: CodeUnterminatedString},
		{in: "\"", code: CodeUnterminatedQuotedIdentifier},
		{in: "$$", code: CodeUnterminatedDollarQuote},
		{in: "$a$ $A$", code: CodeUnterminatedDollarQuote},
		{in: "/*", code: CodeUnterminatedBlockComment},
		{in: "/*/", code: CodeUnterminatedBlockComment},
	}
	for _, c := range cases {
		got, err := ExecutableText([]byte(c.in))
		if c.code != "" {
			if errorCode(err) != c.code {
				t.Errorf("ExecutableText(%q) = %q, %v; want %s", c.in, got, err, c.code)
			}
			continue
		}
		if err != nil || string(got) != c.want {
			t.Errorf("ExecutableText(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	if got, err := ExecutableText(nil); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("empty input: %q, %v; want a non-nil empty text", got, err)
	}
}

// FuzzExecutableText checks that the scanner never panics, that every error
// has a code, and that the result has no leading or trailing space and is a
// fixed point.
func FuzzExecutableText(f *testing.F) {
	for _, seed := range []string{
		"SELECT 'a'\n'b' -- c\n/* d /* e */ */ $f$ g $f$;",
		"E'\\'' U&\"x\" $1 1e'x' a$b$",
		"'unterminated",
		"\xef\xbb\xbf",
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		got, err := ExecutableText(data)
		if err != nil {
			if errorCode(err) == "" {
				t.Fatalf("error without a code: %v", err)
			}
			return
		}
		s := string(got)
		if strings.HasPrefix(s, " ") || strings.HasSuffix(s, " ") {
			t.Fatalf("leading or trailing space in %q", s)
		}
		again, err := ExecutableText(got)
		if err != nil || !bytes.Equal(again, got) {
			t.Fatalf("not a fixed point: %q -> %q, %v", got, again, err)
		}
	})
}

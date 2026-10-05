package canon

import (
	"bytes"
	"errors"
	"math"
	"strings"
	"testing"
)

func errorCode(err error) string {
	var cerr *Error
	if errors.As(err, &cerr) {
		return cerr.Code
	}
	return ""
}

func TestFormatNumber(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0, "0"},
		{math.Copysign(0, -1), "0"},
		{1, "1"},
		{-1, "-1"},
		{0.1, "0.1"},
		{0.30000000000000004, "0.30000000000000004"}, // the double nearest to 0.1+0.2
		{100, "100"},
		{123456789, "123456789"},
		{1e20, "100000000000000000000"},
		{1e21, "1e+21"},
		{1.5e21, "1.5e+21"},
		{1e-6, "0.000001"},
		{1.5e-6, "0.0000015"},
		{1e-7, "1e-7"},
		{1.25e-7, "1.25e-7"},
		{5e-324, "5e-324"},
		{math.MaxFloat64, "1.7976931348623157e+308"},
		{-math.MaxFloat64, "-1.7976931348623157e+308"},
		{1 << 53, "9007199254740992"},
		{4.35, "4.35"},
		{0.002, "0.002"},
		{333333333.3333333, "333333333.3333333"},
		{1e23, "1e+23"},
		{9.999999999999997e22, "9.999999999999997e+22"},
	}
	for _, c := range cases {
		got, err := FormatNumber(c.in)
		if err != nil || got != c.want {
			t.Errorf("FormatNumber(%v) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	for _, f := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, err := FormatNumber(f); errorCode(err) != CodeNumberNotFinite {
			t.Errorf("FormatNumber(%v): got %v, want %s", f, err, CodeNumberNotFinite)
		}
	}
}

func TestParseErrors(t *testing.T) {
	cases := []struct {
		in   string
		code string
	}{
		{"\xff", CodeInvalidJSON},
		{"\"\xc0\xaf\"", CodeInvalidJSON},
		{"\"\xed\xa0\x80\"", CodeInvalidJSON}, // UTF-8 encoded surrogate
		{"[", CodeInvalidJSON},
		{"{\"a\"}", CodeInvalidJSON},
		{"{\"a\":1,}", CodeInvalidJSON},
		{"-", CodeInvalidJSON},
		{"-01", CodeInvalidJSON},
		{".5", CodeInvalidJSON},
		{"1e", CodeInvalidJSON},
		{"1e+", CodeInvalidJSON},
		{"Infinity", CodeInvalidJSON},
		{"tru", CodeInvalidJSON},
		{"nulls", CodeInvalidJSON},
		{"\"\\u12\"", CodeInvalidJSON},
		{"\"\\u12g4\"", CodeInvalidJSON},
		{"\"abc", CodeInvalidJSON},
		{"\"\\", CodeInvalidJSON},
		{"\u00a01", CodeInvalidJSON}, // no-break space is not JSON whitespace
		{"\ufeff1", CodeInvalidJSON}, // a byte order mark is not accepted
		{"\"\\ud800\\udbff\"", CodeLoneSurrogate},
		{"\"\\ud800x\"", CodeLoneSurrogate},
		{"\"\\ud800", CodeLoneSurrogate},
		{"-1e400", CodeNumberNotFinite},
		{"1e99999999999999999999", CodeNumberNotFinite},
		{"{\"a\":{\"b\":1,\"b\":2}}", CodeDuplicateMember},
		{"{\"\\ud83d\\ude00\":1,\"😀\":2}", CodeDuplicateMember},
	}
	for _, c := range cases {
		v, err := Parse([]byte(c.in))
		if got := errorCode(err); got != c.code {
			t.Errorf("Parse(%q) = %v, %v; want code %s", c.in, v, err, c.code)
		}
	}
}

func TestParseAccepts(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"1e-400", "0"},  // underflow rounds to zero, as in ECMAScript
		{"-1e-400", "0"}, // negative zero serializes as 0
		{"\"\\ud83d\\ude00\"", "\"😀\""},
		{"\"\\uDBFF\\uDFFF\"", "\"\U0010FFFF\""},
		{"\"\\u0000\"", "\"\\u0000\""},
		{"\"\\/\"", "\"/\""},
		{"\"\\u007F\"", "\"\x7f\""},
		{" \t\r\n[ ] \t\r\n", "[]"},
		{"{\"a\":[],\"b\":{}}", "{\"a\":[],\"b\":{}}"},
		{"[0,-0,0.0,-0.0,0e5]", "[0,0,0,0,0]"},
		{"2.4703282292062328e-324", "5e-324"},
		{"[\"\\ufdd0\",\"\\ufffe\"]", "[\"\ufdd0\",\"\ufffe\"]"},
	}
	for _, c := range cases {
		got, err := Transform([]byte(c.in))
		if err != nil || string(got) != c.want {
			t.Errorf("Transform(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
}

func TestNestingLimit(t *testing.T) {
	ok := strings.Repeat("[", MaxDepth) + strings.Repeat("]", MaxDepth)
	if _, err := Transform([]byte(ok)); err != nil {
		t.Fatalf("depth %d: %v", MaxDepth, err)
	}
	deep := strings.Repeat("[", MaxDepth+1) + strings.Repeat("]", MaxDepth+1)
	if _, err := Parse([]byte(deep)); errorCode(err) != CodeNestingTooDeep {
		t.Fatalf("depth %d: got %v, want %s", MaxDepth+1, err, CodeNestingTooDeep)
	}
	// A self-referencing Array built by hand must not overflow the stack.
	cycle := Array{nil}
	cycle[0] = cycle
	if _, err := Canonicalize(cycle); errorCode(err) != CodeNestingTooDeep {
		t.Fatalf("cyclic value: got %v, want %s", err, CodeNestingTooDeep)
	}
}

func TestCanonicalizeRefusesInvalidValues(t *testing.T) {
	cases := []struct {
		name string
		v    Value
		code string
	}{
		{"nil", nil, CodeInvalidValue},
		{"nil element", Array{nil}, CodeInvalidValue},
		{"invalid UTF-8 string", String("\xff"), CodeInvalidValue},
		{"encoded surrogate", String("\xed\xa0\x80"), CodeInvalidValue},
		{"invalid UTF-8 name", Object{{Name: "\xff", Value: Null{}}}, CodeInvalidValue},
		{"NaN", Number(math.NaN()), CodeNumberNotFinite},
		{"Inf", Array{Number(math.Inf(1))}, CodeNumberNotFinite},
		{"duplicate names", Object{{Name: "a", Value: Null{}}, {Name: "a", Value: Null{}}}, CodeDuplicateMember},
	}
	for _, c := range cases {
		if _, err := Canonicalize(c.v); errorCode(err) != c.code {
			t.Errorf("%s: got %v, want %s", c.name, err, c.code)
		}
	}
}

func TestCanonicalizeBuiltValue(t *testing.T) {
	v := Object{
		{Name: "b", Value: Array{Number(1), String("x\u2028"), Bool(false)}},
		{Name: "a", Value: Object{}},
		{Name: "\U0001F600", Value: Null{}},
		{Name: "\uFFFF", Value: Number(-0.5)},
	}
	got, err := Canonicalize(v)
	want := "{\"a\":{},\"b\":[1,\"x\u2028\",false],\"\U0001F600\":null,\"\uFFFF\":-0.5}"
	if err != nil || string(got) != want {
		t.Fatalf("got %q, %v; want %q", got, err, want)
	}
	if m, ok := v.Get("a"); !ok || m == nil {
		t.Fatal("Get did not find member a")
	}
	if _, ok := v.Get("A"); ok {
		t.Fatal("Get must not fold case")
	}
}

// FuzzTransform checks that Parse never panics and that canonical output is a
// fixed point of Transform.
func FuzzTransform(f *testing.F) {
	for _, seed := range []string{
		`{"b":[1,2.5e-7,true,null],"a":"\u00e9\ud83d\ude00"}`,
		`[1e21,-0.0,"\u0000\u001f\""]`,
		`{"a":1,"a":2}`,
		`"\ud800"`,
		`1e400`,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		out, err := Transform(data)
		if err != nil {
			if errorCode(err) == "" {
				t.Fatalf("error without a code: %v", err)
			}
			return
		}
		again, err := Transform(out)
		if err != nil || !bytes.Equal(again, out) {
			t.Fatalf("not a fixed point: %q -> %q, %v", out, again, err)
		}
	})
}

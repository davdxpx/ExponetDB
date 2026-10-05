package canon

import (
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Canonicalize returns the RFC 8785 (JCS) serialization of v:
//
//   - no whitespace between tokens;
//   - literals as null, true, false;
//   - numbers as ECMAScript Number::toString (RFC 8785 section 3.2.2.3), so
//     -0 is 0 and NaN or infinities are refused;
//   - strings with only '"', '\' and U+0000 to U+001F escaped, the latter as
//     \b \t \n \f \r or \u00xx with lowercase hexadecimal, and every other
//     code point as literal UTF-8 (RFC 8785 section 3.2.2.2);
//   - object members sorted by the UTF-16 code units of their names, not by
//     bytes or code points (RFC 8785 section 3.2.3); array order is kept.
func Canonicalize(v Value) ([]byte, error) {
	return appendValue(nil, v, 0)
}

// Transform parses data strictly and returns its canonical form.
func Transform(data []byte) ([]byte, error) {
	v, err := Parse(data)
	if err != nil {
		return nil, err
	}
	return Canonicalize(v)
}

func canonError(code, detail string) *Error {
	return &Error{Code: code, Offset: -1, Detail: detail}
}

func appendValue(dst []byte, v Value, depth int) ([]byte, error) {
	switch v := v.(type) {
	case nil:
		return nil, canonError(CodeInvalidValue, "nil Value")
	case Null:
		return append(dst, "null"...), nil
	case Bool:
		if v {
			return append(dst, "true"...), nil
		}
		return append(dst, "false"...), nil
	case Number:
		s, err := FormatNumber(float64(v))
		if err != nil {
			return nil, err
		}
		return append(dst, s...), nil
	case String:
		return appendString(dst, string(v))
	case Array:
		if depth+1 > MaxDepth {
			return nil, canonError(CodeNestingTooDeep, "arrays and objects are nested too deeply")
		}
		dst = append(dst, '[')
		for i, e := range v {
			if i > 0 {
				dst = append(dst, ',')
			}
			var err error
			if dst, err = appendValue(dst, e, depth+1); err != nil {
				return nil, err
			}
		}
		return append(dst, ']'), nil
	case Object:
		if depth+1 > MaxDepth {
			return nil, canonError(CodeNestingTooDeep, "arrays and objects are nested too deeply")
		}
		return appendObject(dst, v, depth+1)
	default:
		// Unreachable: Value is a closed set of types.
		return nil, canonError(CodeInvalidValue, "unknown Value type")
	}
}

func appendObject(dst []byte, o Object, depth int) ([]byte, error) {
	type sortable struct {
		units  []uint16
		member *Member
	}
	members := make([]sortable, len(o))
	for i := range o {
		name := o[i].Name
		if !utf8.ValidString(name) {
			return nil, canonError(CodeInvalidValue, "member name is not valid UTF-8")
		}
		members[i] = sortable{units: utf16.Encode([]rune(name)), member: &o[i]}
	}
	slices.SortFunc(members, func(a, b sortable) int {
		return slices.Compare(a.units, b.units)
	})
	dst = append(dst, '{')
	for i, m := range members {
		if i > 0 {
			// Equal UTF-16 sequences mean equal names for valid UTF-8.
			if slices.Equal(members[i-1].units, m.units) {
				return nil, canonError(CodeDuplicateMember, "member name "+strconv.Quote(m.member.Name)+" occurs more than once")
			}
			dst = append(dst, ',')
		}
		var err error
		if dst, err = appendString(dst, m.member.Name); err != nil {
			return nil, err
		}
		dst = append(dst, ':')
		if dst, err = appendValue(dst, m.member.Value, depth); err != nil {
			return nil, err
		}
	}
	return append(dst, '}'), nil
}

const lowerHex = "0123456789abcdef"

// appendString appends s as a JSON string per RFC 8785 section 3.2.2.2.
func appendString(dst []byte, s string) ([]byte, error) {
	if !utf8.ValidString(s) {
		return nil, canonError(CodeInvalidValue, "string is not valid UTF-8")
	}
	dst = append(dst, '"')
	// Working on bytes is safe: every byte of a multi-byte UTF-8 sequence is
	// >= 0x80 and is copied unchanged.
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			dst = append(dst, '\\', '"')
		case '\\':
			dst = append(dst, '\\', '\\')
		case '\b':
			dst = append(dst, '\\', 'b')
		case '\t':
			dst = append(dst, '\\', 't')
		case '\n':
			dst = append(dst, '\\', 'n')
		case '\f':
			dst = append(dst, '\\', 'f')
		case '\r':
			dst = append(dst, '\\', 'r')
		default:
			if c < 0x20 {
				dst = append(dst, '\\', 'u', '0', '0', lowerHex[c>>4], lowerHex[c&0xF])
			} else {
				dst = append(dst, c)
			}
		}
	}
	return append(dst, '"'), nil
}

// FormatNumber formats f exactly as ECMAScript Number::toString(10)
// (ECMA-262, Number::toString), which RFC 8785 section 3.2.2.3 adopts.
//
// With k the number of digits of the shortest decimal s that rounds to f
// (ties toward the even candidate, closest value first) and n such that
// f = s * 10^(n-k):
//
//	k <= n <= 21   digits of s followed by n-k zeros        (1e20 -> 100000000000000000000)
//	0 < n <= 21    digits with a decimal point after n      (4.5)
//	-6 < n <= 0    "0." then -n zeros then the digits       (0.000001)
//	otherwise      exponent form d[.ddd]e(+|-)(n-1)         (1e+21, 1e-7)
//
// Zero of either sign is "0". NaN and the infinities are refused.
func FormatNumber(f float64) (string, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "", canonError(CodeNumberNotFinite, "NaN and infinities are not JSON numbers")
	}
	if f == 0 {
		return "0", nil // also -0
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	// strconv's shortest formatting yields the shortest digit string that
	// round-trips and, among those, the one closest to f: the digits that
	// ECMA-262 requires. Its layout is "d[.ddd]e(+|-)XX".
	mantissa, exponent, ok := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	if !ok {
		return "", canonError(CodeInvalidValue, "unexpected float formatting")
	}
	digits := strings.Replace(mantissa, ".", "", 1)
	e, err := strconv.Atoi(exponent)
	if err != nil {
		return "", canonError(CodeInvalidValue, "unexpected float formatting")
	}
	k := len(digits)
	n := e + 1

	var b strings.Builder
	b.WriteString(sign)
	switch {
	case k <= n && n <= 21:
		b.WriteString(digits)
		b.WriteString(strings.Repeat("0", n-k))
	case 0 < n && n <= 21:
		b.WriteString(digits[:n])
		b.WriteByte('.')
		b.WriteString(digits[n:])
	case -6 < n && n <= 0:
		b.WriteString("0.")
		b.WriteString(strings.Repeat("0", -n))
		b.WriteString(digits)
	default:
		b.WriteByte(digits[0])
		if k > 1 {
			b.WriteByte('.')
			b.WriteString(digits[1:])
		}
		b.WriteByte('e')
		if n-1 > 0 {
			b.WriteByte('+')
		} else {
			b.WriteByte('-')
		}
		exp := n - 1
		if exp < 0 {
			exp = -exp
		}
		b.WriteString(strconv.Itoa(exp))
	}
	return b.String(), nil
}

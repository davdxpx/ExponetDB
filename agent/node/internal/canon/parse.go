package canon

import (
	"math"
	"strconv"
	"unicode/utf8"
)

// Parse parses data as exactly one JSON value under the strict RFC 8259
// grammar plus the I-JSON constraints that RFC 8785 requires of its input:
//
//   - the input is valid UTF-8 and holds one value, optionally surrounded by
//     the four JSON whitespace characters (space, tab, LF, CR);
//   - no comments, trailing commas, single quotes, unquoted names, leading
//     zeros, leading '+', fractions or exponents without digits, NaN or
//     Infinity, and no escapes other than the RFC 8259 set;
//   - unescaped U+0000 to U+001F inside strings are refused;
//   - member names must be unique after unescaping (duplicate_member);
//   - every \u escape of a surrogate must form a high-low pair
//     (lone_surrogate);
//   - every number must be finite as a double (number_not_finite); a number
//     too small for a double rounds to zero, as in ECMAScript.
//
// Numbers are converted with correct rounding (round half to even) by
// strconv.ParseFloat, which is what ECMAScript's JSON.parse does.
//
// Unicode noncharacters such as U+FFFF are accepted, as by ECMAScript
// JSON.parse; RFC 8785 does not refuse them and the golden vector jcs-003
// depends on that.
func Parse(data []byte) (Value, error) {
	if !utf8.Valid(data) {
		return nil, &Error{Code: CodeInvalidJSON, Offset: firstInvalidUTF8(data), Detail: "input is not valid UTF-8"}
	}
	p := parser{data: data}
	p.skipWhitespace()
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	p.skipWhitespace()
	if p.pos != len(p.data) {
		return nil, p.syntaxError("unexpected data after the top-level value")
	}
	return v, nil
}

func firstInvalidUTF8(data []byte) int {
	for i := 0; i < len(data); {
		r, size := utf8.DecodeRune(data[i:])
		if r == utf8.RuneError && size <= 1 {
			return i
		}
		i += size
	}
	return len(data)
}

type parser struct {
	data  []byte
	pos   int
	depth int
}

func (p *parser) fail(code string, offset int, detail string) *Error {
	return &Error{Code: code, Offset: offset, Detail: detail}
}

func (p *parser) syntaxError(detail string) *Error {
	return p.fail(CodeInvalidJSON, p.pos, detail)
}

// skipWhitespace skips the RFC 8259 "ws" production: space, tab, LF, CR.
func (p *parser) skipWhitespace() {
	for p.pos < len(p.data) {
		switch p.data[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *parser) value() (Value, error) {
	if p.pos >= len(p.data) {
		return nil, p.syntaxError("unexpected end of input, expected a value")
	}
	switch c := p.data[p.pos]; {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		s, err := p.str()
		if err != nil {
			return nil, err
		}
		return String(s), nil
	case c == 't':
		return p.literal("true", Bool(true))
	case c == 'f':
		return p.literal("false", Bool(false))
	case c == 'n':
		return p.literal("null", Null{})
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	default:
		return nil, p.syntaxError("unexpected character, expected a value")
	}
}

func (p *parser) literal(word string, v Value) (Value, error) {
	end := p.pos + len(word)
	if end > len(p.data) || string(p.data[p.pos:end]) != word {
		return nil, p.syntaxError("invalid literal")
	}
	p.pos = end
	return v, nil
}

func (p *parser) enter() error {
	p.depth++
	if p.depth > MaxDepth {
		return p.fail(CodeNestingTooDeep, p.pos, "arrays and objects are nested too deeply")
	}
	return nil
}

func (p *parser) object() (Value, error) {
	if err := p.enter(); err != nil {
		return nil, err
	}
	defer func() { p.depth-- }()
	p.pos++ // '{'
	obj := Object{}
	seen := map[string]struct{}{}
	p.skipWhitespace()
	if p.pos < len(p.data) && p.data[p.pos] == '}' {
		p.pos++
		return obj, nil
	}
	for {
		if p.pos >= len(p.data) || p.data[p.pos] != '"' {
			return nil, p.syntaxError("expected a member name in double quotes")
		}
		nameOffset := p.pos
		name, err := p.str()
		if err != nil {
			return nil, err
		}
		if _, dup := seen[name]; dup {
			return nil, p.fail(CodeDuplicateMember, nameOffset, "member name "+strconv.Quote(name)+" occurs more than once")
		}
		seen[name] = struct{}{}
		p.skipWhitespace()
		if p.pos >= len(p.data) || p.data[p.pos] != ':' {
			return nil, p.syntaxError("expected ':' after a member name")
		}
		p.pos++
		p.skipWhitespace()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		obj = append(obj, Member{Name: name, Value: v})
		p.skipWhitespace()
		if p.pos >= len(p.data) {
			return nil, p.syntaxError("unexpected end of input in an object")
		}
		switch p.data[p.pos] {
		case ',':
			p.pos++
			p.skipWhitespace()
		case '}':
			p.pos++
			return obj, nil
		default:
			return nil, p.syntaxError("expected ',' or '}' in an object")
		}
	}
}

func (p *parser) array() (Value, error) {
	if err := p.enter(); err != nil {
		return nil, err
	}
	defer func() { p.depth-- }()
	p.pos++ // '['
	arr := Array{}
	p.skipWhitespace()
	if p.pos < len(p.data) && p.data[p.pos] == ']' {
		p.pos++
		return arr, nil
	}
	for {
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		arr = append(arr, v)
		p.skipWhitespace()
		if p.pos >= len(p.data) {
			return nil, p.syntaxError("unexpected end of input in an array")
		}
		switch p.data[p.pos] {
		case ',':
			p.pos++
			p.skipWhitespace()
		case ']':
			p.pos++
			return arr, nil
		default:
			return nil, p.syntaxError("expected ',' or ']' in an array")
		}
	}
}

// number scans the RFC 8259 number production
//
//	number = [ "-" ] int [ frac ] [ exp ]
//	int    = "0" / ( digit1-9 *DIGIT )
//	frac   = "." 1*DIGIT
//	exp    = ( "e" / "E" ) [ "-" / "+" ] 1*DIGIT
//
// and converts it to the nearest double.
func (p *parser) number() (Value, error) {
	start := p.pos
	if p.data[p.pos] == '-' {
		p.pos++
	}
	switch {
	case p.pos < len(p.data) && p.data[p.pos] == '0':
		p.pos++
	case p.pos < len(p.data) && p.data[p.pos] >= '1' && p.data[p.pos] <= '9':
		p.skipDigits()
	default:
		return nil, p.syntaxError("a number needs at least one integer digit")
	}
	if p.pos < len(p.data) && p.data[p.pos] == '.' {
		p.pos++
		if !p.skipDigits() {
			return nil, p.syntaxError("a fraction needs at least one digit")
		}
	}
	if p.pos < len(p.data) && (p.data[p.pos] == 'e' || p.data[p.pos] == 'E') {
		p.pos++
		if p.pos < len(p.data) && (p.data[p.pos] == '+' || p.data[p.pos] == '-') {
			p.pos++
		}
		if !p.skipDigits() {
			return nil, p.syntaxError("an exponent needs at least one digit")
		}
	}
	text := string(p.data[start:p.pos])
	f, err := strconv.ParseFloat(text, 64)
	if math.IsInf(f, 0) {
		return nil, p.fail(CodeNumberNotFinite, start, "number "+text+" is outside the range of a double")
	}
	if err != nil {
		// Unreachable for text that matched the grammar above; refuse
		// rather than guess if strconv ever disagrees.
		return nil, p.fail(CodeInvalidJSON, start, "number "+text+" cannot be converted: "+err.Error())
	}
	return Number(f), nil
}

// skipDigits skips ASCII digits and reports whether there was at least one.
func (p *parser) skipDigits() bool {
	start := p.pos
	for p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
		p.pos++
	}
	return p.pos > start
}

// str scans a string starting at the opening quote and returns its decoded
// UTF-8 content.
func (p *parser) str() (string, error) {
	p.pos++ // opening '"'
	var buf []byte
	runStart := p.pos
	for {
		if p.pos >= len(p.data) {
			return "", p.syntaxError("unterminated string")
		}
		c := p.data[p.pos]
		switch {
		case c == '"':
			buf = append(buf, p.data[runStart:p.pos]...)
			p.pos++
			return string(buf), nil
		case c == '\\':
			buf = append(buf, p.data[runStart:p.pos]...)
			var err error
			if buf, err = p.escape(buf); err != nil {
				return "", err
			}
			runStart = p.pos
		case c < 0x20:
			return "", p.syntaxError("unescaped control character in a string")
		default:
			// Bytes of multi-byte sequences are all >= 0x80 and the input
			// was validated as UTF-8 up front, so they are copied as is.
			p.pos++
		}
	}
}

// escape decodes one escape sequence starting at the backslash and appends
// its UTF-8 encoding to buf.
func (p *parser) escape(buf []byte) ([]byte, error) {
	start := p.pos
	if p.pos+1 >= len(p.data) {
		return nil, p.syntaxError("unterminated escape sequence")
	}
	c := p.data[p.pos+1]
	p.pos += 2
	switch c {
	case '"', '\\', '/':
		return append(buf, c), nil
	case 'b':
		return append(buf, '\b'), nil
	case 'f':
		return append(buf, '\f'), nil
	case 'n':
		return append(buf, '\n'), nil
	case 'r':
		return append(buf, '\r'), nil
	case 't':
		return append(buf, '\t'), nil
	case 'u':
	default:
		return nil, p.fail(CodeInvalidJSON, start, "invalid escape sequence")
	}
	r, err := p.hex4()
	if err != nil {
		return nil, err
	}
	switch {
	case r >= 0xDC00 && r <= 0xDFFF:
		return nil, p.fail(CodeLoneSurrogate, start, "low surrogate escape without a preceding high surrogate")
	case r >= 0xD800 && r <= 0xDBFF:
		// A high surrogate must be followed immediately by a \u escape of a
		// low surrogate.
		if p.pos+1 >= len(p.data) || p.data[p.pos] != '\\' || p.data[p.pos+1] != 'u' {
			return nil, p.fail(CodeLoneSurrogate, start, "high surrogate escape without a following low surrogate escape")
		}
		p.pos += 2
		low, err := p.hex4()
		if err != nil {
			return nil, err
		}
		if low < 0xDC00 || low > 0xDFFF {
			return nil, p.fail(CodeLoneSurrogate, start, "high surrogate escape without a following low surrogate escape")
		}
		r = 0x10000 + (r-0xD800)<<10 + (low - 0xDC00)
	}
	return utf8.AppendRune(buf, r), nil
}

// hex4 reads exactly four hexadecimal digits (either case).
func (p *parser) hex4() (rune, error) {
	if p.pos+4 > len(p.data) {
		return 0, p.syntaxError("a \\u escape needs four hexadecimal digits")
	}
	var r rune
	for i := 0; i < 4; i++ {
		c := p.data[p.pos+i]
		var d byte
		switch {
		case c >= '0' && c <= '9':
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, p.fail(CodeInvalidJSON, p.pos+i, "a \\u escape needs four hexadecimal digits")
		}
		r = r<<4 | rune(d)
	}
	p.pos += 4
	return r, nil
}

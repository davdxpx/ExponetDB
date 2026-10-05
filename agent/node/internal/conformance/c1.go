package conformance

import (
	"bytes"
	"unicode/utf8"
)

// c1 SQL refusal codes (migration-bundles.md, N1 and N4).
const (
	CodeInvalidUTF8                  = "invalid_utf8"
	CodeBOM                          = "bom"
	CodeNUL                          = "nul"
	CodeUnterminatedString           = "unterminated_string"
	CodeUnterminatedQuotedIdentifier = "unterminated_quoted_identifier"
	CodeUnterminatedDollarQuote      = "unterminated_dollar_quote"
	CodeUnterminatedBlockComment     = "unterminated_block_comment"
)

// utf8BOM is U+FEFF encoded as UTF-8.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// NormalizeSource applies N1 (input checks) and N2 (line endings) to the raw
// bytes of a SQL file. The result is the input of the source digest and of
// the N4 scan.
func NormalizeSource(src []byte) ([]byte, error) {
	// N1, in this order; the first failure is the result.
	if !utf8.Valid(src) {
		// utf8.Valid refuses overlong forms, encoded surrogates, values above
		// U+10FFFF, truncated sequences and stray continuation bytes.
		return nil, refuse(CodeInvalidUTF8, "the file is not well-formed UTF-8")
	}
	if bytes.HasPrefix(src, utf8BOM) {
		// Only a leading U+FEFF is a byte order mark; elsewhere it is an
		// ordinary character.
		return nil, refuse(CodeBOM, "the file starts with a byte order mark")
	}
	if bytes.IndexByte(src, 0) >= 0 {
		// In valid UTF-8 a zero byte is always U+0000.
		return nil, refuse(CodeNUL, "the file contains U+0000")
	}
	// N2: every CR LF pair becomes LF, then every remaining CR becomes LF,
	// everywhere, including inside literals.
	out := bytes.ReplaceAll(src, []byte("\r\n"), []byte("\n"))
	return bytes.ReplaceAll(out, []byte("\r"), []byte("\n")), nil
}

// ExecutableText returns the c1 executable text of a SQL file (N1 to N5):
// comments outside literals, quoted identifiers and dollar-quoted bodies are
// removed, every run of whitespace and comments between tokens becomes one
// space, a run at either end is removed, and every token is copied unchanged.
// The result may be empty; it is never nil when err is nil.
func ExecutableText(src []byte) ([]byte, error) {
	norm, err := NormalizeSource(src)
	if err != nil {
		return nil, err
	}
	return scanExecutableText([]rune(string(norm)))
}

// N3 character classes over code points.

func isSQLWhitespace(c rune) bool {
	// PostgreSQL 17 and 18 count U+000B as whitespace.
	return c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f'
}

func isIdentStart(c rune) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c >= 0x80
}

func isIdentCont(c rune) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9') || c == '$'
}

func isTagStart(c rune) bool {
	return isIdentStart(c)
}

func isTagCont(c rune) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9')
}

// lexState is the state of the N4 scanner.
type lexState int

const (
	// stBetween: between tokens. The rules R1 to R11 are tried at the current
	// code point, the first match wins.
	stBetween lexState = iota
	// stLineComment: inside a "--" comment (R1). The terminating LF is not
	// part of the comment; it is whitespace for R3.
	stLineComment
	// stBlockComment: inside a nested "/* */" comment (R2).
	stBlockComment
	// stIdentifier: inside an identifier run (R10).
	stIdentifier
	// stString: inside a string literal body (R4, R5, R6).
	stString
	// stAfterString: after the closing quote of a string literal, reading a
	// run of whitespace and line comments that may continue the literal.
	stAfterString
	// stQuotedIdentifier: inside a quoted identifier (R7, R8).
	stQuotedIdentifier
	// stDollarBody: inside a dollar-quoted literal (R9).
	stDollarBody
)

// scanner holds the N4 state machine. Positions are indexes into src, which
// holds code points.
type scanner struct {
	src []rune
	pos int
	st  lexState
	out []byte

	tokenStart int  // start of the token being scanned
	separated  bool // a run of whitespace or comments was seen since the last token

	commentDepth int    // stBlockComment: nesting depth
	escapeMode   bool   // stString: R5 escape mode (backslash escapes the next code point)
	quoteEnd     int    // stAfterString: index just past the closing quote
	sawLF        bool   // stAfterString: the run so far contains an LF
	inComment    bool   // stAfterString: inside a line comment of the run
	delimiter    []rune // stDollarBody: the opening delimiter "$tag$"
}

// at returns the code point at index i, or -1 past the end.
func (s *scanner) at(i int) rune {
	if i < len(s.src) {
		return s.src[i]
	}
	return -1
}

// beginToken starts a token at the current position. N5: the run of
// whitespace and comments before it becomes one space, unless it is at the
// start of the text.
func (s *scanner) beginToken() {
	if s.separated && len(s.out) > 0 {
		s.out = append(s.out, ' ')
	}
	s.separated = false
	s.tokenStart = s.pos
}

// emit copies the token from tokenStart to end unchanged (N5).
func (s *scanner) emit(end int) {
	for _, c := range s.src[s.tokenStart:end] {
		s.out = utf8.AppendRune(s.out, c)
	}
}

// dollarDelimiter returns the length of the R9 opening delimiter
// "$" [tag_start tag_cont*] "$" at the current position, or 0 if there is
// none (then the "$" is an ordinary code point, R11).
func (s *scanner) dollarDelimiter() int {
	i := s.pos + 1
	if isTagStart(s.at(i)) {
		i++
		for isTagCont(s.at(i)) {
			i++
		}
	}
	if s.at(i) == '$' {
		return i + 1 - s.pos
	}
	return 0
}

// delimiterAt reports whether the dollar-quote delimiter starts at the
// current position (tags are case-sensitive).
func (s *scanner) delimiterAt() bool {
	if s.pos+len(s.delimiter) > len(s.src) {
		return false
	}
	for i, c := range s.delimiter {
		if s.src[s.pos+i] != c {
			return false
		}
	}
	return true
}

// step consumes input in the current state. Every call either consumes at
// least one code point or switches to a state that will.
func (s *scanner) step() {
	c := s.src[s.pos]
	switch s.st {
	case stBetween:
		s.stepBetween(c)

	case stLineComment:
		if c == '\n' {
			s.st = stBetween // the LF is whitespace (R3)
		} else {
			s.pos++
		}

	case stBlockComment:
		// R2: "/*" is tested before "*/"; anything else is skipped one code
		// point at a time.
		switch {
		case c == '/' && s.at(s.pos+1) == '*':
			s.commentDepth++
			s.pos += 2
		case c == '*' && s.at(s.pos+1) == '/':
			s.commentDepth--
			s.pos += 2
			if s.commentDepth == 0 {
				s.st = stBetween
			}
		default:
			s.pos++
		}

	case stIdentifier:
		// R10: the longest run of ident_cont.
		if isIdentCont(c) {
			s.pos++
		} else {
			s.emit(s.pos)
			s.st = stBetween
		}

	case stString:
		switch {
		case s.escapeMode && c == '\\':
			// Escape mode: the backslash and the code point after it are
			// content. A backslash at the end leaves the string open.
			s.pos = min(s.pos+2, len(s.src))
		case c == '\'' && s.at(s.pos+1) == '\'':
			s.pos += 2 // '' is content
		case c == '\'':
			s.pos++ // a single quote closes
			s.quoteEnd = s.pos
			s.sawLF = false
			s.inComment = false
			s.st = stAfterString
		default:
			s.pos++
		}

	case stAfterString:
		// String continuation: a run of whitespace and line comments that
		// contains at least one LF and is immediately followed by a quote
		// continues the literal in the same mode; the run and both quotes
		// belong to the token.
		switch {
		case s.inComment:
			if c == '\n' {
				s.inComment = false // the LF is whitespace of the run
			} else {
				s.pos++
			}
		case isSQLWhitespace(c):
			if c == '\n' {
				s.sawLF = true
			}
			s.pos++
		case c == '-' && s.at(s.pos+1) == '-':
			s.inComment = true
			s.pos += 2
		case c == '\'' && s.sawLF:
			s.pos++
			s.st = stString
		default:
			// No continuation: the token ends at the closing quote and the
			// run read so far is an ordinary separator. Only whitespace and
			// line comments were consumed, which stBetween would also have
			// classified as a separator, so nothing is rescanned.
			s.emit(s.quoteEnd)
			s.separated = s.pos > s.quoteEnd
			s.st = stBetween
		}

	case stQuotedIdentifier:
		switch {
		case c == '"' && s.at(s.pos+1) == '"':
			s.pos += 2 // "" is content
		case c == '"':
			s.pos++
			s.emit(s.pos)
			s.st = stBetween
		default:
			s.pos++
		}

	case stDollarBody:
		// The body runs up to the first occurrence of the exact opening
		// delimiter.
		if c == '$' && s.delimiterAt() {
			s.pos += len(s.delimiter)
			s.emit(s.pos)
			s.st = stBetween
		} else {
			s.pos++
		}
	}
}

// stepBetween applies R1 to R11 at the current code point c.
func (s *scanner) stepBetween(c rune) {
	next := s.at(s.pos + 1)
	switch {
	case c == '-' && next == '-': // R1
		s.separated = true
		s.st = stLineComment
		s.pos += 2
	case c == '/' && next == '*': // R2
		s.separated = true
		s.st = stBlockComment
		s.commentDepth = 1
		s.pos += 2
	case isSQLWhitespace(c): // R3
		s.separated = true
		s.pos++
	case c == '\'': // R4
		s.beginToken()
		s.escapeMode = false
		s.st = stString
		s.pos++
	case (c == 'e' || c == 'E') && next == '\'': // R5
		s.beginToken()
		s.escapeMode = true
		s.st = stString
		s.pos += 2
	case (c == 'u' || c == 'U') && next == '&' && s.at(s.pos+2) == '\'': // R6
		s.beginToken()
		s.escapeMode = false
		s.st = stString
		s.pos += 3
	case (c == 'u' || c == 'U') && next == '&' && s.at(s.pos+2) == '"': // R7
		s.beginToken()
		s.st = stQuotedIdentifier
		s.pos += 3
	case c == '"': // R8
		s.beginToken()
		s.st = stQuotedIdentifier
		s.pos++
	case c == '$' && s.dollarDelimiter() > 0: // R9
		s.beginToken()
		n := s.dollarDelimiter()
		s.delimiter = s.src[s.pos : s.pos+n]
		s.st = stDollarBody
		s.pos += n
	case isIdentStart(c): // R10
		s.beginToken()
		s.st = stIdentifier
		s.pos++
	default: // R11: any other code point, including a "$" that opens nothing
		s.beginToken()
		s.pos++
		s.emit(s.pos)
	}
}

// finish handles the end of input.
func (s *scanner) finish() ([]byte, error) {
	switch s.st {
	case stIdentifier:
		s.emit(len(s.src))
	case stAfterString:
		s.emit(s.quoteEnd)
	case stString:
		return nil, refuse(CodeUnterminatedString, "end of input inside a string literal")
	case stQuotedIdentifier:
		return nil, refuse(CodeUnterminatedQuotedIdentifier, "end of input inside a quoted identifier")
	case stDollarBody:
		return nil, refuse(CodeUnterminatedDollarQuote, "end of input inside a dollar-quoted literal")
	case stBlockComment:
		return nil, refuse(CodeUnterminatedBlockComment, "end of input inside a block comment")
	}
	if s.out == nil {
		return []byte{}, nil
	}
	return s.out, nil
}

func scanExecutableText(src []rune) ([]byte, error) {
	s := scanner{src: src, out: make([]byte, 0, len(src))}
	for s.pos < len(s.src) {
		s.step()
	}
	return s.finish()
}

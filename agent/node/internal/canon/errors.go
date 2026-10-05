package canon

import "fmt"

// Stable error codes. They are part of the package contract: callers and
// golden vectors compare Error.Code against these strings.
const (
	// CodeInvalidJSON is any violation of the RFC 8259 grammar, including
	// input that is not valid UTF-8.
	CodeInvalidJSON = "invalid_json"
	// CodeDuplicateMember is an object with two members whose names are equal
	// after unescaping (I-JSON, RFC 7493 section 2.3).
	CodeDuplicateMember = "duplicate_member"
	// CodeLoneSurrogate is a \u escape of a surrogate code point that is not
	// part of a high-low surrogate pair (I-JSON, RFC 7493 section 2.1).
	CodeLoneSurrogate = "lone_surrogate"
	// CodeNumberNotFinite is a number whose magnitude overflows an IEEE 754
	// double (I-JSON, RFC 7493 section 2.2), or a NaN or infinite Number
	// handed to Canonicalize.
	CodeNumberNotFinite = "number_not_finite"
	// CodeNestingTooDeep is input nested deeper than MaxDepth. RFC 8259
	// section 9 allows an implementation to limit nesting; the limit keeps
	// hostile input from exhausting the stack.
	CodeNestingTooDeep = "nesting_too_deep"
	// CodeInvalidValue is a Value handed to Canonicalize that is not JSON: a
	// nil Value, or a String or member name that is not valid UTF-8.
	CodeInvalidValue = "invalid_value"
)

// MaxDepth is the deepest nesting of arrays and objects that Parse and
// Canonicalize accept. The top-level array or object is depth 1.
const MaxDepth = 1000

// Error is a refusal by Parse or Canonicalize.
type Error struct {
	// Code is one of the Code constants.
	Code string
	// Offset is the byte offset in the input at which Parse detected the
	// problem, or -1 for errors from Canonicalize.
	Offset int
	// Detail is a human-readable explanation. It is not part of the contract.
	Detail string
}

func (e *Error) Error() string {
	if e.Offset >= 0 {
		return fmt.Sprintf("canon: %s at byte %d: %s", e.Code, e.Offset, e.Detail)
	}
	return fmt.Sprintf("canon: %s: %s", e.Code, e.Detail)
}

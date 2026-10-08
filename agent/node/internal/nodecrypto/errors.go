package nodecrypto

import "fmt"

// Error is a caller error of this package (a key of the wrong size, a value
// that cannot be canonicalized). Refusals of untrusted input are reason codes
// or false, never an Error.
type Error struct {
	Detail string
}

func (e *Error) Error() string {
	return "nodecrypto: " + e.Detail
}

func errorf(format string, args ...any) *Error {
	return &Error{Detail: fmt.Sprintf(format, args...)}
}

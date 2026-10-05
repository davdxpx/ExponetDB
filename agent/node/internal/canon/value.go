// Package canon implements strict JSON parsing (RFC 8259 with the I-JSON
// constraints of RFC 7493 that RFC 8785 relies on) and the JSON
// Canonicalization Scheme of RFC 8785 (JCS).
//
// The package is the single canonical-JSON implementation of the agent
// module. The conformance tests use it to recompute ExponetDB's frozen hash
// contracts, and the agent's job-signature verification uses it in a later
// wave, so it refuses rather than guesses: every input that RFC 8785 cannot
// canonicalize unambiguously is an *Error with a stable Code.
//
// The value model is a small closed sum type: Null, Bool, Number, String,
// Array and Object. An Object keeps its members in input order; Canonicalize
// sorts them. Numbers are IEEE 754 doubles, exactly as in ECMAScript, which is
// the number model RFC 8785 assumes.
package canon

// Value is a JSON value. The concrete types are Null, Bool, Number, String,
// Array and Object; no other type can implement Value.
type Value interface {
	isValue()
}

// Null is the JSON literal null.
type Null struct{}

// Bool is a JSON literal true or false.
type Bool bool

// Number is a JSON number as an IEEE 754 double. NaN and the infinities are
// not JSON numbers; Canonicalize refuses them.
type Number float64

// String is a JSON string held as UTF-8. Canonicalize refuses a String that is
// not valid UTF-8 (a lone surrogate cannot be represented in valid UTF-8).
type String string

// Array is a JSON array. Element order is significant and preserved.
type Array []Value

// Object is a JSON object with its members in input order. Member names must
// be unique; Parse guarantees it and Canonicalize checks it.
type Object []Member

// Member is one name/value pair of an Object.
type Member struct {
	Name  string
	Value Value
}

func (Null) isValue()   {}
func (Bool) isValue()   {}
func (Number) isValue() {}
func (String) isValue() {}
func (Array) isValue()  {}
func (Object) isValue() {}

// Get returns the value of the member called name and whether it exists.
// Names are compared exactly (byte for byte), never folded.
func (o Object) Get(name string) (Value, bool) {
	for _, m := range o {
		if m.Name == name {
			return m.Value, true
		}
	}
	return nil, false
}

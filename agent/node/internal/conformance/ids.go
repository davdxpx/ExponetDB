package conformance

import "strings"

// Id refusal reasons (domain-model.md §2), in the order the rules are checked.
const (
	// ReasonInvalidPrefix: there is no "_", or the text before the first "_"
	// is not one of the lowercase prefixes.
	ReasonInvalidPrefix = "invalid_prefix"
	// ReasonWrongPrefix: a known prefix other than the expected one.
	ReasonWrongPrefix = "wrong_prefix"
	// ReasonNotCanonical: the ULID part would be canonical after ASCII
	// uppercasing; ids are never folded.
	ReasonNotCanonical = "not_canonical"
	// ReasonInvalidULID: anything else about the ULID part.
	ReasonInvalidULID = "invalid_ulid"
)

// KindMigration is the kind of a bare migration ULID, which never carries a
// prefix (ADR-0006).
const KindMigration = "migration"

// CodeUnknownKind is returned by ValidateID for an expected kind that is
// neither a known prefix nor KindMigration. It is a caller error, not one of
// the specified refusal reasons.
const CodeUnknownKind = "unknown_kind"

// idPrefixes is the prefix table of domain-model.md §2 (ins, sec and prc were
// added in Wave 2; fac, cap, chl and rau in Wave 3A) plus "req" for request
// ids, which are correlation ids rather than stored entities.
var idPrefixes = map[string]bool{
	"prd": true, "prj": true, "env": true, "tgt": true, "plc": true,
	"srv": true, "nod": true, "cls": true, "dbs": true, "end": true,
	"crd": true, "bkr": true, "bkp": true, "rst": true, "crt": true,
	"pln": true, "op": true, "job": true, "apr": true, "bgl": true,
	"evd": true, "idn": true, "rlb": true, "cli": true, "grt": true,
	"key": true, "ses": true, "aud": true, "fnd": true, "smp": true,
	"ins": true, "sec": true, "prc": true,
	"fac": true, "cap": true, "chl": true, "rau": true,
	"req": true,
}

// IsKnownPrefix reports whether p (without the underscore) is an id prefix.
func IsKnownPrefix(p string) bool {
	return idPrefixes[p]
}

// IsCanonicalULID reports whether s is a ULID in its canonical form: 26
// characters of uppercase Crockford base32 (no I, L, O, U) with a first
// character from 0 to 7, so that the value fits in 128 bits.
func IsCanonicalULID(s string) bool {
	if len(s) != 26 || s[0] < '0' || s[0] > '7' {
		return false
	}
	for i := 1; i < len(s); i++ {
		if !isCrockfordUpper(s[i]) {
			return false
		}
	}
	return true
}

func isCrockfordUpper(c byte) bool {
	switch {
	case c >= '0' && c <= '9':
		return true
	case c >= 'A' && c <= 'Z':
		return c != 'I' && c != 'L' && c != 'O' && c != 'U'
	}
	return false
}

// asciiUpper uppercases ASCII letters only; every other byte, including the
// bytes of non-ASCII characters, is kept.
func asciiUpper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - ('a' - 'A')
		}
	}
	return string(b)
}

// ValidateID checks value against the expected kind: a prefix without the
// underscore (for example "tgt" or "req"), or KindMigration for a bare
// migration ULID. It returns nil for a valid id and otherwise an *Error whose
// Code names the first failing rule, checked in this order: invalid_prefix,
// wrong_prefix, not_canonical, invalid_ulid. Ids are compared byte for byte.
func ValidateID(value, kind string) error {
	ulid := value
	if kind != KindMigration {
		if !idPrefixes[kind] {
			return refuse(CodeUnknownKind, "unknown expected kind %q", kind)
		}
		prefix, rest, found := strings.Cut(value, "_")
		if !found || !idPrefixes[prefix] {
			return refuse(ReasonInvalidPrefix, "%q does not start with a known lowercase prefix and '_'", value)
		}
		if prefix != kind {
			return refuse(ReasonWrongPrefix, "prefix %q where %q is expected", prefix, kind)
		}
		ulid = rest
	}
	switch {
	case IsCanonicalULID(ulid):
		return nil
	case IsCanonicalULID(asciiUpper(ulid)):
		return refuse(ReasonNotCanonical, "%q is a ULID only after uppercasing; ids are never folded", ulid)
	default:
		return refuse(ReasonInvalidULID, "%q is not a 26-character canonical ULID", ulid)
	}
}

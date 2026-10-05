package conformance

import "strconv"

// Timeout refusal codes (N7).
const (
	// CodeInvalidDuration: the value does not match the duration grammar of
	// migration-bundles.md §2 (or is not a string).
	CodeInvalidDuration = "invalid_duration"
	// CodeDurationOutOfRange: the value is outside 1 ms to 6 h.
	CodeDurationOutOfRange = "duration_out_of_range"
)

// Timeout bounds in milliseconds (migration-bundles.md §2). Zero is refused
// because PostgreSQL reads 0 as "no timeout".
const (
	minTimeoutMillis = 1
	maxTimeoutMillis = 6 * 60 * 60 * 1000
)

// durationUnits lists the units in their mandatory order with their size in
// milliseconds.
var durationUnits = [...]struct {
	suffix string
	millis int64
}{
	{"h", 60 * 60 * 1000},
	{"m", 60 * 1000},
	{"s", 1000},
	{"ms", 1},
}

// ParseDurationMillis parses the duration grammar of migration-bundles.md §2
//
//	^(N h)?(N m)?(N s)?(N ms)?$   N = 0|[1-9][0-9]{0,8}   (no spaces)
//
// with at least one component, and returns the total in milliseconds. It
// does not check the timeout bounds; see TimeoutMillis.
func ParseDurationMillis(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	var total int64
	nextUnit := 0 // index of the first unit still allowed; enforces order and uniqueness
	for i := 0; i < len(s); {
		j := i
		for j < len(s) && s[j] >= '0' && s[j] <= '9' {
			j++
		}
		digits := s[i:j]
		if len(digits) == 0 || len(digits) > 9 || (len(digits) > 1 && digits[0] == '0') {
			return 0, false
		}
		// The unit: "ms" is tried before "m". A minute component directly
		// followed by "s" cannot exist because every component starts with a
		// digit, so this is the only reading the regular expression allows.
		var unit int
		switch {
		case j+1 < len(s) && s[j] == 'm' && s[j+1] == 's':
			unit, j = 3, j+2
		case j < len(s) && s[j] == 'h':
			unit, j = 0, j+1
		case j < len(s) && s[j] == 'm':
			unit, j = 1, j+1
		case j < len(s) && s[j] == 's':
			unit, j = 2, j+1
		default:
			return 0, false
		}
		if unit < nextUnit {
			return 0, false // out of order or repeated
		}
		nextUnit = unit + 1
		n, err := strconv.ParseInt(digits, 10, 64)
		if err != nil {
			return 0, false
		}
		// At most 999999999 h, about 3.6e15 ms in total: no overflow.
		total += n * durationUnits[unit].millis
		i = j
	}
	return total, true
}

// TimeoutMillis parses a lockTimeout or statementTimeout value and checks
// the bounds 1 ms to 6 h.
func TimeoutMillis(s string) (int64, error) {
	ms, ok := ParseDurationMillis(s)
	if !ok {
		return 0, refuse(CodeInvalidDuration, "%q is not a duration such as 5s, 10m or 1h30m", s)
	}
	if ms < minTimeoutMillis || ms > maxTimeoutMillis {
		return 0, refuse(CodeDurationOutOfRange, "%q is outside 1ms to 6h", s)
	}
	return ms, nil
}

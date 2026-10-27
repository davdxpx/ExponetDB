package helper

import (
	"regexp"
	"strings"
)

// Engine output never leaves the host raw (ADR-0037 §2, security.md §2
// item 10): an excerpt keeps printable ASCII only, drops anything that looks
// like a key, password, credential or token, and keeps the last lines up to
// a cap. Standard error is redacted like standard output; neither is ever
// logged.

var redactions = []struct {
	re   *regexp.Regexp
	repl string
}{
	// key=value and key: value pairs whose key names a secret
	// (repo1-cipher-pass=…, AWS_SECRET_ACCESS_KEY=…, password=…).
	{regexp.MustCompile(`(?i)([A-Za-z0-9_.-]*(?:pass|passwd|password|secret|token|credential|access[_-]?key|private[_-]?key|api[_-]?key|session)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)`), "$1$2<redacted>"},
	// Credentials in URLs (scheme://user:secret@host).
	{regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://)[^/\s@]+@`), "$1<redacted>@"},
	// Authorization headers.
	{regexp.MustCompile(`(?i)(authorization|bearer)(\s*[:=]?\s*)\S+`), "$1$2<redacted>"},
	// Long hex runs (keys, digests).
	{regexp.MustCompile(`[0-9A-Fa-f]{32,}`), "<redacted>"},
}

// randomRuns are base64 runs (standard and URL-safe); one is a secret when
// it mixes upper case, lower case and digits, as random key material does
// and host paths, labels and run ids do not.
var randomRuns = []*regexp.Regexp{
	regexp.MustCompile(`[A-Za-z0-9+/]{32,}={0,2}`),
	regexp.MustCompile(`[A-Za-z0-9_-]{32,}`),
}

func looksRandom(s string) bool {
	var upper, lower, digit bool
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z':
			upper = true
		case r >= 'a' && r <= 'z':
			lower = true
		case r >= '0' && r <= '9':
			digit = true
		}
	}
	return upper && lower && digit
}

// redactLine removes secrets from one line of host text.
func redactLine(line string) string {
	var b strings.Builder
	for _, r := range line {
		switch {
		case r == '\t':
			b.WriteByte(' ')
		case r < 0x20 || r > 0x7e:
			b.WriteByte('?')
		default:
			b.WriteRune(r)
		}
	}
	s := b.String()
	for _, r := range redactions {
		s = r.re.ReplaceAllString(s, r.repl)
	}
	for _, re := range randomRuns {
		s = re.ReplaceAllStringFunc(s, func(m string) string {
			if looksRandom(m) {
				return "<redacted>"
			}
			return m
		})
	}
	return s
}

// Redact returns the last lines of text, each redacted, joined by newlines
// and at most max bytes (older lines are dropped first; a single longer line
// keeps its end).
func Redact(text string, max int) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	var kept []string
	size := 0
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimRight(redactLine(lines[i]), " ")
		if l == "" {
			continue
		}
		if size+len(l)+1 > max {
			if len(kept) == 0 {
				kept = append(kept, l[len(l)-max:])
			}
			break
		}
		kept = append(kept, l)
		size += len(l) + 1
	}
	for i, j := 0, len(kept)-1; i < j; i, j = i+1, j-1 {
		kept[i], kept[j] = kept[j], kept[i]
	}
	return strings.Join(kept, "\n")
}

// tail keeps the last n bytes written to it (engine output while it runs).
type tail struct {
	n   int
	buf []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > 2*t.n {
		t.buf = append([]byte{}, t.buf[len(t.buf)-t.n:]...)
	}
	return len(p), nil
}

func (t *tail) String() string {
	if len(t.buf) > t.n {
		return string(t.buf[len(t.buf)-t.n:])
	}
	return string(t.buf)
}

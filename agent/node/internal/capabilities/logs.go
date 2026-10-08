package capabilities

import (
	"context"
	"encoding/hex"
	"net"
	"regexp"
	"strings"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// Redact removes what must never leave the host in a log line (clean-room;
// security.md): passwords and verifiers, password hashes, connection-string
// and URI passwords, secret JSON members, bearer and enrollment tokens,
// sealed values and IP addresses.
func Redact(line string) string {
	out, _ := redactLine(line)
	return out
}

// passwordLiteral is the keyword PASSWORD followed by a string literal of any
// form (standard, with an E or U& prefix, dollar-quoted), with or without
// space. A literal can hold anything that would end a narrower pattern, so
// everything from the literal on is withheld, and so are the lines that
// continue the statement.
var passwordLiteral = regexp.MustCompile(`(?i)\bpassword\s*(?:[e]|u&)?(?:'|\$[A-Za-z_0-9]*\$)`)

// redactLine redacts one line; open reports a password literal that started
// on it, so the lines continuing the same log entry are withheld too.
func redactLine(line string) (string, bool) {
	open := false
	if m := passwordLiteral.FindStringIndex(line); m != nil {
		keyword := m[0] + len("password")
		line, open = line[:keyword]+" [redacted]", true
	}
	for _, r := range redactions {
		line = r.re.ReplaceAllString(line, r.with)
	}
	return redactIPv6(line), open
}

// ipv6Candidate is a run of hex digits, colons and dots between non-word
// characters; it is redacted only when it parses as an address, so a cast
// such as 0::int stays as it is.
var ipv6Candidate = regexp.MustCompile(`(^|[^0-9A-Za-z:.])([0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*)($|[^0-9A-Za-z:])`)

func redactIPv6(line string) string {
	var b strings.Builder
	last := 0
	for _, m := range ipv6Candidate.FindAllStringSubmatchIndex(line, -1) {
		start, end := m[4], m[5]
		if start < last || net.ParseIP(strings.TrimSuffix(line[start:end], ".")) == nil {
			continue
		}
		b.WriteString(line[last:start])
		b.WriteString("[ip]")
		last = end
	}
	b.WriteString(line[last:])
	return b.String()
}

var redactions = []struct {
	re   *regexp.Regexp
	with string
}{
	{regexp.MustCompile(`(?i)(password\s*[=:]\s*)('(?:[^']|'')*'|\S+)`), "${1}[redacted]"},
	{regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://[^/\s:@]*:)[^@\s/]*@`), "${1}[redacted]@"},
	{regexp.MustCompile(`(?i)("(?:password|passwd|pwd|secret|token|verifier)"\s*:\s*)"(?:[^"\\]|\\.)*"`), `${1}"[redacted]"`},
	{regexp.MustCompile(`SCRAM-SHA-256\$[^\s'",]+`), "[redacted]"},
	{regexp.MustCompile(`\bmd5[0-9a-f]{32}\b`), "[redacted]"},
	{regexp.MustCompile(`exdbt1\.[A-Za-z0-9_.-]+`), "[redacted]"},
	{regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+`), "${1}[redacted]"},
	{regexp.MustCompile(`"ns1"\s*:\s*\{[^}]*\}`), `"ns1":[redacted]`},
	{regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`), "[ip]"},
}

var severityRank = map[string]int{"debug": 0, "info": 1, "notice": 2, "warning": 3, "error": 4, "fatal": 5, "panic": 6}

// pgSeverity maps a PostgreSQL message level to the contract's scale.
func pgSeverity(level string) (string, bool) {
	switch {
	case strings.HasPrefix(level, "DEBUG"):
		return "debug", true
	case level == "LOG" || level == "INFO":
		return "info", true
	case level == "NOTICE":
		return "notice", true
	case level == "WARNING":
		return "warning", true
	case level == "ERROR":
		return "error", true
	case level == "FATAL":
		return "fatal", true
	case level == "PANIC":
		return "panic", true
	}
	return "", false
}

// The Debian default prefix: '%m [%p] %q%u@%d ' then "LEVEL:  message".
var pgLineRE = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?) ([A-Z]{2,5}|[+-]\d{2}(?::?\d{2})?) \[\d+\][^:]*?\b(DEBUG[1-5]|LOG|INFO|NOTICE|WARNING|ERROR|FATAL|PANIC|DETAIL|HINT|STATEMENT|CONTEXT|QUERY|LOCATION):\s+(.*)$`)

type logLine struct {
	at       *time.Time
	severity string
	rank     int
	text     string
	// cont: a line continuing the entry before it (no prefix).
	cont bool
}

func parseZone(s string) *time.Location {
	if s == "UTC" || s == "GMT" {
		return time.UTC
	}
	if loc, err := time.LoadLocation(s); err == nil {
		return loc
	}
	return nil
}

func parsePgLog(content string) []logLine {
	var out []logLine
	var last *logLine
	for _, raw := range strings.Split(content, "\n") {
		if raw == "" {
			continue
		}
		m := pgLineRE.FindStringSubmatch(raw)
		if m == nil {
			// A continuation without a prefix (a multi-line statement).
			if last != nil {
				out = append(out, logLine{at: last.at, severity: last.severity, rank: last.rank, text: raw, cont: true})
			}
			continue
		}
		var at *time.Time
		if loc := parseZone(m[2]); loc != nil {
			if t, err := time.ParseInLocation("2006-01-02 15:04:05.999999", m[1], loc); err == nil {
				u := t.UTC()
				at = &u
			}
		}
		level := m[3]
		sev, ok := pgSeverity(level)
		l := logLine{at: at, severity: level, text: level + ":  " + m[4]}
		if ok {
			l.rank = severityRank[sev]
		} else if last != nil {
			// DETAIL, HINT, STATEMENT, CONTEXT belong to the message before.
			l.rank = last.rank
		}
		out = append(out, l)
		last = &out[len(out)-1]
	}
	return out
}

// dataLevels are the PostgreSQL message parts that quote data: a statement's
// text, its parameters, a key's or row's values (Wave 5 correction F1,
// capabilities.md §6). They are withheld whole, with the lines continuing
// them.
var dataLevels = map[string]bool{"DETAIL": true, "STATEMENT": true, "QUERY": true, "CONTEXT": true}

// statementMessage is a LOG line of statement logging: its text is a client's
// SQL, which can hold any literal.
var statementMessage = regexp.MustCompile(`^LOG:  (?:duration: [0-9.]+ ms  )?(?:statement|execute|bind|parse)\b`)

// quotedValue is a value PostgreSQL quotes at the end of a message (`invalid
// value for parameter "x": "..."`, `invalid input syntax for type integer:
// "..."`) or after `changed to` (a reloaded parameter's new value).
var quotedValue = regexp.MustCompile(`(: |changed to )"(?:[^"]|"")*"\s*$`)

// classifyLine withholds what a log line can quote of data; true when the
// lines continuing it are withheld too.
func classifyLine(text string) (string, bool) {
	level, _, _ := strings.Cut(text, ":")
	if dataLevels[level] {
		return level + ":  [withheld]", true
	}
	if statementMessage.MatchString(text) {
		return "LOG:  [withheld: statement]", true
	}
	return quotedValue.ReplaceAllString(text, "${1}[withheld]"), false
}

// redactEntries redacts in log order, before anything is picked, so a
// continuation line is withheld even when the line that opened a password
// literal or a statement is not shown. A line is classified by its message
// first (what PostgreSQL quotes of data), then redacted (passwords, tokens,
// addresses that remain).
func redactEntries(lines []logLine) {
	withhold := false
	for i := range lines {
		if !lines[i].cont {
			withhold = false
		}
		if withhold {
			lines[i].text = "[withheld]"
			continue
		}
		text, data := classifyLine(clean(lines[i].text))
		var open bool
		lines[i].text, open = redactLine(text)
		withhold = withhold || open || data
	}
}

type logInspect struct{ fixed }

func (p logInspect) Precondition(args canon.Object) error {
	if text(args, "source") != "postgresql" {
		return nil
	}
	return p.env.clusterPrecondition(args)
}

// maxLogBytes bounds how much of a log file is read (its end).
const maxLogBytes = 8 << 20

func (p logInspect) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	since, _ := time.Parse(time.RFC3339Nano, text(job.Args, "since"))
	until, _ := time.Parse(time.RFC3339Nano, text(job.Args, "until"))
	minRank := severityRank[text(job.Args, "minSeverity")]
	n, _ := member(job.Args, "maxLines").(canon.Number)
	maxLines := int(n)
	var lines []logLine
	switch text(job.Args, "source") {
	case "postgresql":
		_, c, err := p.env.session(ctx, job.Args, "")
		if err != nil {
			return nil, err
		}
		defer c.Close()
		name, _ := clusterRef(job.Args)
		major, cluster, _ := strings.Cut(name, "/")
		rows, err := c.Query(ctx, `SELECT CASE WHEN st.size IS NULL THEN NULL ELSE
			pg_catalog.pg_read_binary_file($1, greatest(st.size - $2::bigint, 0), $2::bigint) END AS content
			FROM pg_catalog.pg_stat_file($1, true) st`, "/var/log/postgresql/postgresql-"+major+"-"+cluster+".log", maxLogBytes)
		if err != nil {
			return nil, err
		}
		if r := rows.Each(); len(r) > 0 && !r[0].Null("content") {
			data, err := hex.DecodeString(strings.TrimPrefix(r[0].Text("content"), `\x`))
			if err != nil {
				return nil, err
			}
			lines = parsePgLog(strings.ToValidUTF8(string(data), "�"))
		}
	default:
		out, err := p.env.Helper.Call(ctx, helperproto.OpLogRead, job.Envelope)
		if err != nil {
			return nil, err
		}
		for _, item := range list(out, "lines") {
			o, _ := item.(canon.Object)
			l := logLine{severity: text(o, "severity"), rank: severityRank[text(o, "severity")], text: text(o, "text")}
			if t, err := time.Parse(time.RFC3339Nano, text(o, "at")); err == nil {
				l.at = &t
			}
			lines = append(lines, l)
		}
	}
	redactEntries(lines)
	var picked []logLine
	for _, l := range lines {
		if l.at != nil && (l.at.Before(since) || !l.at.Before(until)) {
			continue
		}
		if l.rank < minRank {
			continue
		}
		picked = append(picked, l)
	}
	truncated := false
	if len(picked) > maxLines {
		picked, truncated = picked[len(picked)-maxLines:], true
	}
	result := canon.Array{}
	for _, l := range picked {
		var sev any
		if l.severity != "" {
			sev = bound(l.severity, 16)
		}
		result = append(result, obj("at", l.at, "severity", sev, "text", bound(l.text, 2048)))
	}
	if err := step(run, "read"); err != nil {
		return nil, err
	}
	return obj("lines", result, "truncated", truncated), nil
}

// clean turns control characters into spaces.
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\t' || r == 0x7f {
			return ' '
		}
		return r
	}, s)
}

package capabilities

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgfiles"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgwire"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// ----- pg_hba.conf as PostgreSQL reads it -----
//
// pg_hba_file_rules loses the quotes of database and role names (a quoted
// "replication" reads like the keyword), so the lockout check parses the
// file itself: whitespace separated fields, comma separated lists, double
// quotes make a name literal, # starts a comment.

type token struct {
	text   string
	quoted bool
}

type hbaLine struct {
	number int
	fields [][]token // each field is a comma separated list
}

func tokenizeHba(content []byte) []hbaLine {
	var out []hbaLine
	for i, raw := range strings.Split(string(content), "\n") {
		var fields [][]token
		var field []token
		var cur strings.Builder
		quoted, inQuote, had := false, false, false
		flushToken := func() {
			if had {
				field = append(field, token{text: cur.String(), quoted: quoted})
			}
			cur.Reset()
			quoted, had = false, false
		}
		flushField := func() {
			flushToken()
			if len(field) > 0 {
				fields = append(fields, field)
			}
			field = nil
		}
		for j := 0; j < len(raw); j++ {
			ch := raw[j]
			switch {
			case inQuote && ch == '"':
				inQuote = false
			case inQuote:
				cur.WriteByte(ch)
			case ch == '#':
				j = len(raw)
			case ch == '"':
				inQuote, quoted, had = true, true, true
			case ch == ',':
				flushToken()
			case ch == ' ' || ch == '\t' || ch == '\r':
				flushField()
			default:
				cur.WriteByte(ch)
				had = true
			}
		}
		flushField()
		if len(fields) > 0 {
			out = append(out, hbaLine{number: i + 1, fields: fields})
		}
	}
	return out
}

// protectedAccess is ExponetDB's own access that must keep working.
type protectedAccess struct {
	Role, Database, Address, Method string
}

// errUncertain: a rule before the match cannot be judged here (a group, a
// regular expression, a file reference, samerole, a host name, an include):
// the change is refused rather than guessed (fail closed).
var errUncertain = errors.New("a rule before the match cannot be judged")

func isKeyword(t token, words ...string) bool {
	if t.quoted {
		return false
	}
	for _, w := range words {
		if t.text == w {
			return true
		}
	}
	return false
}

// listMatch: 1 match, 0 no match, -1 uncertain.
func listMatch(items []token, want string, database bool, role string) int {
	result := 0
	for _, t := range items {
		switch {
		case isKeyword(t, "all"):
			return 1
		case database && isKeyword(t, "sameuser"):
			if role == want {
				return 1
			}
		case database && isKeyword(t, "replication"):
			// Only replication connections; ExponetDB's are not.
		case !t.quoted && (strings.HasPrefix(t.text, "@") || strings.HasPrefix(t.text, "/") || strings.HasPrefix(t.text, "+")),
			isKeyword(t, "samerole", "samegroup"):
			result = -1
		case t.text == want:
			return 1
		}
	}
	return result
}

func addressMatch(fields [][]token, address string) (int, int) {
	if len(fields) == 0 || len(fields[0]) != 1 {
		return -1, 0
	}
	a := fields[0][0]
	if isKeyword(a, "all") {
		return 1, 1
	}
	if isKeyword(a, "samehost", "samenet") {
		return -1, 1
	}
	ip := net.ParseIP(address)
	if _, network, err := net.ParseCIDR(a.text); err == nil {
		if network.Contains(ip) {
			return 1, 1
		}
		return 0, 1
	}
	if host := net.ParseIP(a.text); host != nil && len(fields) > 1 && len(fields[1]) == 1 {
		mask := net.ParseIP(fields[1][0].text)
		if mask == nil {
			return -1, 2
		}
		m := net.IPMask(mask.To16())
		if host.To4() != nil {
			m = net.IPMask(mask.To4())
			host = host.To4()
			ip = ip.To4()
		}
		if ip != nil && host.Mask(m).Equal(ip.Mask(m)) {
			return 1, 2
		}
		return 0, 2
	}
	return -1, 1 // a host name
}

// matchAccess finds the first rule that applies to the access and reports
// its line when it accepts with the access's method.
func matchAccess(lines []hbaLine, a protectedAccess) (int, error) {
	for _, l := range lines {
		if len(l.fields) == 0 || len(l.fields[0]) != 1 {
			return 0, errUncertain
		}
		kind := l.fields[0][0].text
		if strings.HasPrefix(kind, "include") {
			return 0, errUncertain
		}
		local := a.Address == "local"
		applies := (local && kind == "local") || (!local && (kind == "host" || kind == "hostssl" || kind == "hostnogssenc"))
		if !applies || len(l.fields) < 4 {
			continue
		}
		db := listMatch(l.fields[1], a.Database, true, a.Role)
		user := listMatch(l.fields[2], a.Role, false, "")
		addr, used := 1, 0
		if !local {
			addr, used = addressMatch(l.fields[3:], a.Address)
		}
		if db == 0 || user == 0 || addr == 0 {
			continue
		}
		if db < 0 || user < 0 || addr < 0 {
			return 0, errUncertain
		}
		methodField := 3 + used
		if methodField >= len(l.fields) || len(l.fields[methodField]) != 1 {
			return 0, errUncertain
		}
		if l.fields[methodField][0].text != a.Method {
			return 0, fmt.Errorf("line %d answers with %s, not %s", l.number, l.fields[methodField][0].text, a.Method)
		}
		return l.number, nil
	}
	return 0, errors.New("no rule accepts it")
}

// ----- postgres.hba.inspect@1 -----

type hbaInspect struct{ clusterBound }

func hbaFileOf(ctx context.Context, c *pgwire.Conn, in config.Instance) ([]byte, error) {
	rows, err := c.Query(ctx, `SELECT current_setting('hba_file') AS f`)
	if err != nil {
		return nil, err
	}
	if got := rows.Each()[0].Text("f"); got != in.HbaFile {
		return nil, preconditionf("the server reads another pg_hba.conf than the operator mapped")
	}
	content, present, err := readFile(ctx, c, in.HbaFile)
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, preconditionf("pg_hba.conf is missing")
	}
	return content, nil
}

func ruleErrors(ctx context.Context, c *pgwire.Conn) (canon.Array, error) {
	rows, err := c.Query(ctx, `SELECT file_name, line_number, error FROM pg_catalog.pg_hba_file_rules
		WHERE error IS NOT NULL ORDER BY rule_number LIMIT 64`)
	if err != nil {
		return nil, err
	}
	out := canon.Array{}
	for _, r := range rows.Each() {
		var file, line any
		if v := r.TextOrNil("file_name"); v != nil {
			file = bound(*v, 4096)
		}
		if !r.Null("line_number") {
			line = r.Int("line_number")
		}
		out = append(out, obj("sourcefile", file, "sourceline", line, "error", bound(r.Text("error"), 1024)))
	}
	return out, nil
}

func arrayItems(s string) []string {
	s = strings.TrimSuffix(strings.TrimPrefix(s, "{"), "}")
	if s == "" {
		return []string{}
	}
	var out []string
	for _, p := range strings.Split(s, ",") {
		out = append(out, strings.Trim(p, `"`))
	}
	return out
}

func (p hbaInspect) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	in, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	content, err := hbaFileOf(ctx, c, in)
	if err != nil {
		return nil, err
	}
	block, err := pgfiles.FindBlock(content)
	if err != nil {
		return nil, preconditionf("pg_hba.conf has ambiguous managed block markers")
	}
	first, last := 0, -1
	var blockDigest any
	if block.Present {
		first = strings.Count(string(content[:block.Start]), "\n") + 1
		last = first + block.Lines + 1
		blockDigest = pgfiles.Digest(content[block.Start:block.End])
	}
	rows, err := c.Query(ctx, `SELECT line_number, type, array_to_string(database, chr(31)) AS database,
		array_to_string(user_name, chr(31)) AS users, address, netmask, auth_method,
		array_to_string(options, chr(31)) AS options, error
		FROM pg_catalog.pg_hba_file_rules WHERE file_name = $1 OR file_name IS NULL ORDER BY rule_number LIMIT 1024`, in.HbaFile)
	if err != nil {
		return nil, err
	}
	rules := canon.Array{}
	split := func(s string, n int) canon.Array {
		out := canon.Array{}
		if s == "" {
			return out
		}
		for _, x := range strings.Split(s, "\x1f") {
			out = append(out, canon.String(bound(x, n)))
		}
		return out
	}
	for _, r := range rows.Each() {
		nullable := func(col string, n int) any {
			if v := r.TextOrNil(col); v != nil {
				return bound(*v, n)
			}
			return nil
		}
		var line any
		managed := false
		if !r.Null("line_number") {
			n := r.Int("line_number")
			line = n
			managed = block.Present && int(n) > first && int(n) < last
		}
		rules = append(rules, obj("lineNumber", line, "type", nullable("type", 16), "database", split(r.Text("database"), 256),
			"userName", split(r.Text("users"), 256), "address", nullable("address", 256), "netmask", nullable("netmask", 64),
			"authMethod", nullable("auth_method", 32), "options", split(r.Text("options"), 512), "managed", managed,
			"error", nullable("error", 1024)))
	}
	if err := step(run, "inspect"); err != nil {
		return nil, err
	}
	return obj("hbaFile", in.HbaFile, "fileDigest", pgfiles.Digest(content),
		"managedBlock", obj("present", block.Present, "digest", blockDigest, "lineCount", block.Lines), "rules", rules), nil
}

// ----- postgres.hba.apply@1 -----

type hbaApply struct{ clusterBound }

func protectedOf(args canon.Object) []protectedAccess {
	var out []protectedAccess
	for _, item := range list(args, "protectedAccess") {
		o, _ := item.(canon.Object)
		out = append(out, protectedAccess{Role: text(o, "role"), Database: text(o, "database"),
			Address: text(o, "address"), Method: text(o, "method")})
	}
	return out
}

// Run writes the managed block through the helper, checks the written file
// before PostgreSQL loads it (parse errors, ExponetDB's own access still
// accepted with its method), puts the previous file back and fails when
// either check fails, reloads, and probes a fresh session afterwards (G5
// item 7).
func (p hbaApply) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	in, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	content, err := hbaFileOf(ctx, c, in)
	if err != nil {
		return nil, err
	}
	if pgfiles.Digest(content) != text(job.Args, "expectedFileDigest") {
		return nil, preconditionf("pg_hba.conf changed since the plan")
	}
	access := protectedOf(job.Args)
	if err := step(run, "check"); err != nil {
		return nil, err
	}
	if err := run.BeginEffect(); err != nil {
		return nil, err
	}
	written, err := p.env.Helper.Call(ctx, helperproto.OpHbaWrite, job.Envelope)
	if err != nil {
		return nil, err
	}
	if err := step(run, "write_file"); err != nil {
		return nil, err
	}
	restore := func(reason error) (canon.Object, error) {
		if _, err := p.env.Helper.Call(ctx, helperproto.OpHbaRestore, job.Envelope); err != nil {
			return nil, fmt.Errorf("%v; and the previous pg_hba.conf could not be restored: %w", reason, err)
		}
		_ = step(run, "restore")
		return nil, fmt.Errorf("the previous pg_hba.conf was restored: %w", reason)
	}
	errs, err := ruleErrors(ctx, c)
	if err != nil {
		return restore(err)
	}
	if len(errs) > 0 {
		return restore(errors.New("the written pg_hba.conf has errors"))
	}
	now, _, err := readFile(ctx, c, in.HbaFile)
	if err != nil {
		return restore(err)
	}
	lines := tokenizeHba(now)
	// The agent's own access is always kept, whatever the plan names
	// (control-plane.md §9.6); it is checked here and not reported.
	own := protectedAccess{Role: p.env.role(), Database: "postgres", Address: "local", Method: "peer"}
	if _, err := matchAccess(lines, own); err != nil {
		return restore(fmt.Errorf("the agent's own access %s@%s over the local socket would be lost: %w", own.Role, own.Database, err))
	}
	matched := canon.Array{}
	for _, a := range access {
		line, err := matchAccess(lines, a)
		if err != nil {
			return restore(fmt.Errorf("ExponetDB's access %s@%s from %s would be lost: %w", a.Role, a.Database, a.Address, err))
		}
		matched = append(matched, obj("access", obj("role", a.Role, "database", a.Database, "address", a.Address, "method", a.Method),
			"matchedLine", line))
	}
	if err := step(run, "check_rules"); err != nil {
		return nil, err
	}
	if err := reload(ctx, c); err != nil {
		return nil, err
	}
	if err := step(run, "reload"); err != nil {
		return nil, err
	}
	// The probe: a fresh session of the agent's own access after the reload.
	probe, err := p.env.connect(ctx, in, "")
	if err != nil {
		// The existing session is not affected by the reload: it loads the
		// restored file again.
		_, rerr := restore(errors.New("the agent's own session is refused after the reload"))
		_ = reload(ctx, c)
		return nil, rerr
	}
	_ = probe.Close()
	if err := step(run, "probe"); err != nil {
		return nil, err
	}
	return obj("fileDigest", text(written, "fileDigest"), "previousFileDigest", text(written, "previousFileDigest"),
		"reloaded", true, "ruleErrors", canon.Array{}, "protectedAccess", matched), nil
}

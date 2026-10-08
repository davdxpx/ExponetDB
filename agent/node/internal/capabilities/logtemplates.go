package capabilities

import (
	"regexp"
	"strings"
)

// The PostgreSQL server log is exported by an allowlist (Wave 5 correction
// review of F1, capabilities.md §6): a message is shown only when it is one
// of the server messages below, written at one of its levels, whose
// variable parts are numbers, LSNs, times, process ids, fixed words or a
// parameter's name. A part that can hold a client's or a file's text (a
// quoted value, a role, database or relation name, a host, a path, the rest
// of a connection line) is replaced by [withheld]; a mistyped password ends
// up as the user name of a failed login. Every other message, every DETAIL,
// HINT, STATEMENT, CONTEXT, QUERY and LOCATION part and every line that
// continues an entry is withheld whole.
//
// A client can write any text at LOG or ERROR (RAISE), also from processes
// whose lines carry no session (parallel, autovacuum and other background
// workers run client code), so neither a message's form nor its prefix
// proves who wrote it (correction review, rounds 2 and 3). What a line can
// show is therefore limited to what the server itself fixes: the fixed
// words of a template, words of fixed vocabularies, numbers in the exact
// formats PostgreSQL 16 to 18 write, a parameter's name only when the
// server knows the parameter, and the start line only when it is the
// server's own version string. In a line of a session a parameter's name is
// withheld too, and a server whose log_line_prefix is not the Debian
// default has every line read as a session's. What a client can still make
// appear is one of these messages with numbers it chose.
var pgTemplates = compileTemplates([]pgTemplateSource{
	// Start, stop and recovery: the postmaster and its own processes.
	server("LOG", `starting {version}`),
	server("LOG", `listening on IPv[46] address {q}, port {n}`),
	server("LOG", `listening on Unix socket {q}`),
	server("LOG", `database system was shut down at {t}`),
	server("LOG", `database system was shut down in recovery at {t}`),
	server("LOG", `database system was interrupted; last known up at {t}`),
	server("LOG", `database system was interrupted while in recovery at {t}`),
	server("LOG", `database system was not properly shut down; automatic recovery in progress`),
	server("LOG", `database system is ready to accept (?:read-only )?connections`),
	server("LOG", `database system is shut down`),
	server("LOG", `received (?:fast|smart|immediate) shutdown request`),
	server("LOG", `received SIGHUP, reloading configuration files`),
	server("LOG", `aborting any active transactions`),
	server("LOG", `shutting down`),
	server("LOG", `background worker {q} \(PID {n}\) exited with exit code {n}`),
	server("LOG", `server process \(PID {n}\) was terminated by signal {n}: {signal}`),
	server("LOG", `server process \(PID {n}\) exited with exit code {n}`),
	server("LOG", `terminating any other active server processes`),
	server("LOG", `all server processes terminated; reinitializing`),
	server("LOG", `checkpoint starting:{ckflags}`),
	server("LOG", `checkpoint complete: {ckpt}`),
	server("LOG", `restartpoint starting:{ckflags}`),
	server("LOG", `restartpoint complete: {ckpt}`),
	server("LOG", `recovery restart point at {lsn}`),
	server("LOG", `redo starts at {lsn}`),
	server("LOG", `redo done at {lsn} system usage: {usage}`),
	server("LOG", `redo is not required`),
	server("LOG", `consistent recovery state reached at {lsn}`),
	server("LOG", `entering standby mode`),
	server("LOG", `started streaming WAL from primary at {lsn} on timeline {n}`),
	server("LOG", `selected new timeline ID: {n}`),
	server("LOG", `archive recovery complete`),
	server("LOG", `autovacuum launcher (?:started|shutting down)`),
	server("LOG|WARNING|FATAL", `archive command failed with exit code {n}`),
	server("LOG", `automatic (?:vacuum|analyze) of table {q}:{w}`),
	// Configuration: a reload in the postmaster; a SET in a session.
	server("LOG", `parameter {name} changed to {q}`),
	server("LOG", `parameter {name} removed from configuration file, reset to default`),
	server("LOG", `configuration file {q} contains errors; (?:unaffected changes were applied|no changes were applied)`),
	server("LOG|WARNING", `{w} was not reloaded`),
	server("LOG", `could not translate RADIUS server name {q} to address: {w}`),
	anyProc("LOG|ERROR", `parameter {name} cannot be changed without restarting the server`),
	anyProc("LOG|ERROR", `parameter {name} cannot be changed now`),
	anyProc("LOG|ERROR", `invalid value for parameter {name}: {q}`),
	anyProc("LOG|ERROR", `unrecognized configuration parameter {q}(?: in file {q} line {n})?`),
	// Connections and authentication.
	anyProc("LOG", `connection received: {w}`),
	anyProc("LOG", `connection authenticated: {w}`),
	anyProc("LOG", `connection authorized: {w}`),
	anyProc("LOG", `disconnection: session time: [0-9:.]+ {w}`),
	anyProc("LOG", `temporary file: path {q}, size {n}`),
	anyProc("FATAL", `password authentication failed for user {q}`),
	anyProc("FATAL", `no pg_hba.conf entry for {w}`),
	anyProc("FATAL", `pg_hba.conf rejects connection for {w}`),
	anyProc("FATAL|ERROR", `role {q} does not exist`),
	anyProc("FATAL|ERROR", `database {q} does not exist`),
	anyProc("FATAL", `role {q} is not permitted to log in`),
	anyProc("FATAL", `too many connections for (?:role|database) {q}`),
	anyProc("FATAL", `sorry, too many clients already`),
	anyProc("FATAL", `remaining connection slots are reserved for {w}`),
	anyProc("FATAL", `the database system is (?:starting up|shutting down|in recovery mode|not yet accepting connections|not accepting connections)`),
	anyProc("FATAL", `terminating connection due to (?:administrator command|idle-session timeout|idle-in-transaction timeout|conflict with recovery|unexpected postmaster exit)`),
	anyProc("FATAL", `terminating autovacuum process due to administrator command`),
	anyProc("LOG", `unexpected EOF on client connection(?: with an open transaction)?`),
	anyProc("LOG", `could not (?:receive data from|send data to) client: {oserr}`),
	anyProc("ERROR", `permission denied to set role {q}`),
	anyProc("ERROR", `permission denied to set session authorization {q}`),
	anyProc("ERROR", `role {q} has not been granted membership in role {q} by role {q}`),
	// Statements (never their text or values).
	anyProc("ERROR", `canceling statement due to (?:statement timeout|user request|lock timeout|conflict with recovery)`),
	anyProc("ERROR", `canceling autovacuum task`),
	anyProc("ERROR", `deadlock detected`),
	anyProc("ERROR", `could not serialize access due to (?:concurrent update|concurrent delete|read/write dependencies among transactions)`),
	anyProc("ERROR", `could not obtain lock on (?:relation|row in relation) {q}`),
	anyProc("ERROR", `duplicate key value violates unique constraint {q}`),
	anyProc("ERROR", `null value in column {q} of relation {q} violates not-null constraint`),
	anyProc("ERROR", `new row for relation {q} violates check constraint {q}`),
	anyProc("ERROR", `insert or update on table {q} violates foreign key constraint {q}`),
	anyProc("ERROR", `update or delete on table {q} violates foreign key constraint {q} on table {q}`),
	anyProc("ERROR", `relation {q} does not exist`),
	anyProc("ERROR", `column {q} does not exist`),
	anyProc("ERROR", `function {w} does not exist`),
	anyProc("ERROR|FATAL", `permission denied for (?:table|schema|database|function|sequence|view|relation|materialized view|procedure|type|language|large object) {w}`),
	anyProc("ERROR", `syntax error at or near {q}`),
	anyProc("ERROR", `syntax error at end of input`),
	anyProc("ERROR", `invalid input syntax for type {type}: {q}`),
	anyProc("ERROR", `value {q} is out of range for type {type}`),
	anyProc("ERROR", `value too long for type {type}\([0-9]+\)`),
	anyProc("ERROR", `current transaction is aborted, commands ignored until end of transaction block`),
	anyProc("WARNING", `there is (?:no|already a) transaction in progress`),
	anyProc("ERROR", `division by zero`),
	anyProc("ERROR|FATAL", `out of (?:shared )?memory`),
})

// pgTemplateSource is one message: the levels PostgreSQL writes it at, and
// whether only a process without a session writes it.
type pgTemplateSource struct {
	levels     string
	serverOnly bool
	src        string
}

func server(levels, src string) pgTemplateSource  { return pgTemplateSource{levels, true, src} }
func anyProc(levels, src string) pgTemplateSource { return pgTemplateSource{levels, false, src} }

type pgTemplate struct {
	levels map[string]bool
	// server matches a line without a session; session one of a session
	// (nil: only the server writes the message).
	server, session *regexp.Regexp
}

// Fixed vocabularies: words PostgreSQL itself writes in these parts.
const (
	typeWords = `(?:smallint|integer|bigint|numeric|real|double precision|boolean|uuid|date|` +
		`time(?:stamp)?(?: with(?:out)? time zone)?|interval|jsonb?|bytea|inet|cidr|macaddr8?|oid|money|` +
		`bit(?: varying)?|character(?: varying)?|xml|tsvector|tsquery|pg_lsn|point|line|lseg|box|path|polygon|circle|` +
		`regclass|regproc|regprocedure|regtype|regrole|regnamespace|regoper|regoperator|regconfig|regdictionary)`
	osErrors = `(?:Connection reset by peer|Broken pipe|Connection timed out|No route to host|Network is unreachable|` +
		`Software caused connection abort|Transport endpoint is not connected|Connection refused)`
	signals = `(?:Hangup|Interrupt|Quit|Illegal instruction|Trace/breakpoint trap|Aborted|Bus error|` +
		`Floating point exception|Killed|User defined signal [12]|Segmentation fault|Alarm clock|Terminated)`
	// Each flag at most once, in the order PostgreSQL 16 to 18 print them.
	checkpointFlags = `(?: shutdown)?(?: end-of-recovery)?(?: immediate)?(?: force)?(?: wait)?(?: wal)?(?: time)?(?: flush-all)?`
	// The exact statistics of a checkpoint or restartpoint (PostgreSQL 16 and
	// 17; 18 adds the SLRU buffers).
	checkpointBody = `wrote [0-9]+ buffers \([0-9]+\.[0-9]%\)(?:, wrote [0-9]+ SLRU buffers)?; ` +
		`[0-9]+ WAL file\(s\) added, [0-9]+ removed, [0-9]+ recycled; ` +
		`write=[0-9]+\.[0-9]{3} s, sync=[0-9]+\.[0-9]{3} s, total=[0-9]+\.[0-9]{3} s; ` +
		`sync files=[0-9]+, longest=[0-9]+\.[0-9]{3} s, average=[0-9]+\.[0-9]{3} s; ` +
		`distance=[0-9]+ kB, estimate=[0-9]+ kB; lsn=[0-9A-F]{1,8}/[0-9A-F]{1,8}, redo lsn=[0-9A-F]{1,8}/[0-9A-F]{1,8}`
	usageBody = `CPU: user: [0-9]+\.[0-9]{2} s, system: [0-9]+\.[0-9]{2} s, elapsed: [0-9]+\.[0-9]{2} s`
	paramName = `"[a-z_][a-z0-9_.]{0,126}"`
)

func compileTemplates(src []pgTemplateSource) []pgTemplate {
	common := []string{
		// A quoted value of any content: withheld.
		"{q}", `(?P<w>"(?:[^"]|"")*")`,
		// The rest of a message: withheld.
		"{w}", `(?P<w>.*)`,
		"{n}", `-?[0-9]+(?:\.[0-9]+)?`,
		"{lsn}", `[0-9A-F]{1,8}/[0-9A-F]{1,8}`,
		// A time; a zone name only as the line's own prefix names it.
		"{t}", `[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?: (?P<z>[A-Za-z]{1,5})| [+-][0-9]{2}(?::?[0-9]{2})?)?`,
		"{type}", typeWords,
		"{oserr}", osErrors,
		"{signal}", signals,
		"{ckflags}", checkpointFlags,
		"{ckpt}", checkpointBody,
		"{usage}", usageBody,
		// The start line's version: shown only when it is the server's own.
		"{version}", `(?P<v>PostgreSQL [^\x00-\x1f]{1,512})`,
	}
	// A parameter's name is shown when the server knows the parameter; in a
	// line of a session it is the session's text: withheld.
	serverMacros := strings.NewReplacer(append([]string{"{name}", `(?P<p>` + paramName + `)`}, common...)...)
	sessionMacros := strings.NewReplacer(append([]string{"{name}", `(?P<w>` + paramName + `)`}, common...)...)
	compile := func(r *strings.Replacer, s string) *regexp.Regexp {
		// PostgreSQL appends the error position to a message in the log.
		return regexp.MustCompile(`^(?:` + r.Replace(s) + `)(?: at character [0-9]+)?$`)
	}
	out := make([]pgTemplate, 0, len(src))
	for _, s := range src {
		t := pgTemplate{levels: map[string]bool{}, server: compile(serverMacros, s.src)}
		for _, l := range strings.Split(s.levels, "|") {
			t.levels[l] = true
		}
		if !s.serverOnly {
			t.session = compile(sessionMacros, s.src)
		}
		out = append(out, t)
	}
	return out
}

// withheldLevels are the parts of an entry that quote data or files: they
// are never shown.
var withheldLevels = map[string]bool{"DETAIL": true, "HINT": true, "STATEMENT": true, "CONTEXT": true, "QUERY": true, "LOCATION": true}

// pgServer is what the server says of itself, read in the same session as
// its log: the names of its parameters, its version string, and whether its
// log_line_prefix is the Debian default, whose %q leaves user@database out
// of the lines of processes without a client connection.
type pgServer struct {
	params      map[string]bool
	version     string
	debianLines bool
}

// classifyPgLine renders one parsed PostgreSQL log line ("LEVEL:  message")
// by the allowlist: the message as its template shows it, or withheld.
// session: the line's prefix names a user and a database; server: nil when
// nothing is known of the server (then every line counts as a session's and
// nothing of the server is confirmed).
func classifyPgLine(level, message string, session bool, server *pgServer, zone string) string {
	if server == nil {
		server = &pgServer{}
	}
	if !server.debianLines {
		session = true
	}
	if !withheldLevels[level] {
		for _, t := range pgTemplates {
			re := t.server
			if session {
				re = t.session
			}
			if re == nil || !t.levels[level] {
				continue
			}
			m := re.FindStringSubmatchIndex(message)
			if m == nil {
				continue
			}
			var b strings.Builder
			last := 0
			for i, name := range re.SubexpNames() {
				if m[2*i] < 0 {
					continue
				}
				part := message[m[2*i]:m[2*i+1]]
				shown := false
				switch name {
				case "p":
					shown = server.params[strings.Trim(part, `"`)]
				case "v":
					shown = server.version != "" && part == server.version
				case "z":
					shown = zone != "" && part == zone
				case "w":
				default:
					continue
				}
				if shown {
					continue
				}
				b.WriteString(message[last:m[2*i]])
				b.WriteString("[withheld]")
				last = m[2*i+1]
			}
			b.WriteString(message[last:])
			return level + ":  " + b.String()
		}
	}
	return level + ":  [withheld]"
}

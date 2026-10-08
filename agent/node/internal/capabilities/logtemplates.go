package capabilities

import (
	"regexp"
	"strings"
)

// The PostgreSQL server log is exported by an allowlist (Wave 5 correction
// review of F1, capabilities.md §6): a message is shown only when it is one
// of the server messages below, whose variable parts are numbers, LSNs,
// times, process ids, fixed words or a parameter's name. A part that can
// hold a client's or a file's text (a quoted value, a role, database or
// relation name, a host, a path, the rest of a connection line) is replaced
// by [withheld]; a mistyped password ends up as the user name of a failed
// login. Every other message, every DETAIL, HINT, STATEMENT, CONTEXT, QUERY
// and LOCATION part and every line that continues an entry is withheld
// whole, so nothing a client sends reaches the result by matching a
// pattern over its text.
var pgTemplates = compileTemplates([]string{
	// Start, stop and recovery.
	`starting PostgreSQL [0-9][0-9.]*(?: \([A-Za-z0-9 ._+~-]*\))? on [A-Za-z0-9_.-]+, compiled by [A-Za-z0-9 ()._+~-]*, [0-9]+-bit`,
	`listening on IPv[46] address {q}, port {n}`,
	`listening on Unix socket {q}`,
	`database system was shut down at {t}`,
	`database system was shut down in recovery at {t}`,
	`database system was interrupted; last known up at {t}`,
	`database system was interrupted while in recovery at {t}`,
	`database system was not properly shut down; automatic recovery in progress`,
	`database system is ready to accept (?:read-only )?connections`,
	`database system is shut down`,
	`received (?:fast|smart|immediate) shutdown request`,
	`received SIGHUP, reloading configuration files`,
	`aborting any active transactions`,
	`shutting down`,
	`background worker {q} \(PID {n}\) exited with exit code {n}`,
	`server process \(PID {n}\) was terminated by signal {n}: [A-Za-z ]+`,
	`server process \(PID {n}\) exited with exit code {n}`,
	`terminating any other active server processes`,
	`all server processes terminated; reinitializing`,
	`checkpoint starting:(?: [a-z-]+)+`,
	`checkpoint complete: [A-Za-z0-9 ,;:=()%./_-]*`,
	`restartpoint starting:(?: [a-z-]+)+`,
	`restartpoint complete: [A-Za-z0-9 ,;:=()%./_-]*`,
	`recovery restart point at {lsn}`,
	`redo starts at {lsn}`,
	`redo done at {lsn} system usage: [A-Za-z0-9 ,:.]*`,
	`redo is not required`,
	`consistent recovery state reached at {lsn}`,
	`entering standby mode`,
	`started streaming WAL from primary at {lsn} on timeline {n}`,
	`selected new timeline ID: {n}`,
	`archive recovery complete`,
	`autovacuum launcher (?:started|shutting down)`,
	`archive command failed with exit code {n}`,
	`temporary file: path {q}, size {n}`,
	`automatic (?:vacuum|analyze) of table {q}:{w}`,
	// Configuration.
	`parameter {name} changed to {q}`,
	`parameter {name} removed from configuration file, reset to default`,
	`parameter {name} cannot be changed without restarting the server`,
	`parameter {name} cannot be changed now`,
	`invalid value for parameter {name}: {q}`,
	`unrecognized configuration parameter {q}(?: in file {q} line {n})?`,
	`configuration file {q} contains errors; (?:unaffected changes were applied|no changes were applied)`,
	`{w} was not reloaded`,
	`could not translate RADIUS server name {q} to address: [A-Za-z ]+`,
	// Connections and authentication.
	`connection received: {w}`,
	`connection authenticated: {w}`,
	`connection authorized: {w}`,
	`disconnection: session time: [0-9:.]+ {w}`,
	`password authentication failed for user {q}`,
	`no pg_hba.conf entry for {w}`,
	`pg_hba.conf rejects connection for {w}`,
	`role {q} does not exist`,
	`database {q} does not exist`,
	`role {q} is not permitted to log in`,
	`too many connections for (?:role|database) {q}`,
	`sorry, too many clients already`,
	`remaining connection slots are reserved for {w}`,
	`the database system is (?:starting up|shutting down|in recovery mode|not yet accepting connections|not accepting connections)`,
	`terminating connection due to (?:administrator command|idle-session timeout|idle-in-transaction timeout|conflict with recovery|unexpected postmaster exit)`,
	`terminating autovacuum process due to administrator command`,
	`unexpected EOF on client connection(?: with an open transaction)?`,
	`could not (?:receive data from|send data to) client: [A-Za-z ]+`,
	`permission denied to set role {q}`,
	`permission denied to set session authorization {q}`,
	`role {q} has not been granted membership in role {q} by role {q}`,
	// Statements (never their text or values).
	`canceling statement due to (?:statement timeout|user request|lock timeout|conflict with recovery)`,
	`canceling autovacuum task`,
	`deadlock detected`,
	`could not serialize access due to (?:concurrent update|concurrent delete|read/write dependencies among transactions)`,
	`could not obtain lock on (?:relation|row in relation) {q}`,
	`duplicate key value violates unique constraint {q}`,
	`null value in column {q} of relation {q} violates not-null constraint`,
	`new row for relation {q} violates check constraint {q}`,
	`insert or update on table {q} violates foreign key constraint {q}`,
	`update or delete on table {q} violates foreign key constraint {q} on table {q}`,
	`relation {q} does not exist`,
	`column {q} does not exist`,
	`function {w} does not exist`,
	`permission denied for (?:table|schema|database|function|sequence|view|relation|materialized view|procedure|type|language|large object) {w}`,
	`syntax error at or near {q}`,
	`syntax error at end of input`,
	`invalid input syntax for type [a-z ]+: {q}`,
	`value {q} is out of range for type [a-z ]+`,
	`value too long for type [a-z ]+\([0-9]+\)`,
	`current transaction is aborted, commands ignored until end of transaction block`,
	`there is (?:no|already a) transaction in progress`,
	`division by zero`,
	`out of (?:shared )?memory`,
})

func compileTemplates(src []string) []*regexp.Regexp {
	macros := strings.NewReplacer(
		// A quoted value of any content: withheld.
		"{q}", `(?P<w>"(?:[^"]|"")*")`,
		// The rest of a message: withheld.
		"{w}", `(?P<w>.*)`,
		// A parameter's name: shown.
		"{name}", `"[a-z_][a-z0-9_.]{0,126}"`,
		"{n}", `-?[0-9]+(?:\.[0-9]+)?`,
		"{lsn}", `[0-9A-F]{1,8}/[0-9A-F]{1,8}`,
		"{t}", `[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?: [A-Za-z]{1,5}| [+-][0-9]{2}(?::?[0-9]{2})?)?`,
	)
	out := make([]*regexp.Regexp, 0, len(src))
	for _, s := range src {
		// PostgreSQL appends the error position to a message in the log.
		out = append(out, regexp.MustCompile(`^(?:`+macros.Replace(s)+`)(?: at character [0-9]+)?$`))
	}
	return out
}

// withheldLevels are the parts of an entry that quote data or files: they
// are never shown.
var withheldLevels = map[string]bool{"DETAIL": true, "HINT": true, "STATEMENT": true, "CONTEXT": true, "QUERY": true, "LOCATION": true}

// classifyPgLine renders one parsed PostgreSQL log line ("LEVEL:  message")
// by the allowlist: the message as its template shows it, or withheld.
func classifyPgLine(level, message string) string {
	if !withheldLevels[level] {
		for _, re := range pgTemplates {
			m := re.FindStringSubmatchIndex(message)
			if m == nil {
				continue
			}
			var b strings.Builder
			last := 0
			for i, name := range re.SubexpNames() {
				if name != "w" || m[2*i] < 0 {
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

package capabilities

import (
	"errors"
	"strings"
	"testing"
)

func TestMatchAccessFirstRuleWins(t *testing.T) {
	agent := protectedAccess{Role: "exponetdb_node", Database: "postgres", Address: "local", Method: "peer"}
	tcp := protectedAccess{Role: "exponetdb_cp", Database: "app", Address: "10.0.0.5", Method: "scram-sha-256"}
	for _, c := range []struct {
		name, file string
		access     protectedAccess
		line       int
		err        string
	}{
		{"own line", "local all exponetdb_node peer map=exponetdb\nlocal all all reject\n", agent, 1, ""},
		{"rejected first", "local all all reject\nlocal all exponetdb_node peer\n", agent, 0, "answers with reject"},
		{"other method", "local all exponetdb_node md5\n", agent, 0, "answers with md5"},
		{"no rule", "host all all 0.0.0.0/0 scram-sha-256\n", agent, 0, "no rule"},
		{"quoted keyword is a name", "local \"all\" exponetdb_node reject\nlocal all exponetdb_node peer\n", agent, 2, ""},
		{"group before", "local all +admins reject\nlocal all exponetdb_node peer\n", agent, 0, "cannot be judged"},
		{"regex before", "local all /^exp reject\nlocal all exponetdb_node peer\n", agent, 0, "cannot be judged"},
		{"include before", "include other.conf\nlocal all exponetdb_node peer\n", agent, 0, "cannot be judged"},
		{"comment and blank", "# c\n\n  local all exponetdb_node peer # x\n", agent, 3, ""},
		{"cidr", "hostssl app exponetdb_cp 10.0.0.0/8 scram-sha-256\n", tcp, 1, ""},
		{"cidr outside", "hostssl app exponetdb_cp 192.168.0.0/16 scram-sha-256\n", tcp, 0, "no rule"},
		{"ip and mask", "host all all 10.0.0.0 255.0.0.0 scram-sha-256\n", tcp, 1, ""},
		{"hostnossl does not apply", "hostnossl all all all reject\nhostssl all all all scram-sha-256\n", tcp, 2, ""},
		{"samehost before", "host all all samehost reject\nhostssl all all all scram-sha-256\n", tcp, 0, "cannot be judged"},
		{"host name before", "host all all db.example reject\nhostssl all all all scram-sha-256\n", tcp, 0, "cannot be judged"},
		{"replication is not ours", "hostssl replication all all reject\nhostssl all all all scram-sha-256\n", tcp, 2, ""},
		{"sameuser", "hostssl sameuser all all reject\nhostssl all all all scram-sha-256\n", tcp, 2, ""},
	} {
		line, err := matchAccess(tokenizeHba([]byte(c.file)), c.access)
		switch {
		case c.err == "" && (err != nil || line != c.line):
			t.Errorf("%s: line %d err %v", c.name, line, err)
		case c.err != "" && (err == nil || !strings.Contains(err.Error(), c.err)):
			t.Errorf("%s: want %q, got %v", c.name, c.err, err)
		}
	}
	if _, err := matchAccess(tokenizeHba([]byte("local all +g reject\n")), agent); !errors.Is(err, errUncertain) {
		t.Fatal(err)
	}
}

func TestCheckValue(t *testing.T) {
	min, max := "64", "2147483647"
	workMem := setting{name: "work_mem", vartype: "integer", unit: "kB", minVal: &min, maxVal: &max}
	for v, want := range map[string]string{"64MB": "", "1GB": "", "32kB": "out_of_range", "64": "", "lots": "invalid_value", "1.5MB": ""} {
		if got := checkValue(workMem, v); got != want {
			t.Errorf("work_mem %s: %q", v, got)
		}
	}
	zero, big := "0", "2147483647"
	timeout := setting{vartype: "integer", unit: "ms", minVal: &zero, maxVal: &big}
	for v, want := range map[string]string{"30s": "", "-5": "out_of_range", "2min": "", "5 parsecs": "invalid_value"} {
		if got := checkValue(timeout, v); got != want {
			t.Errorf("timeout %s: %q", v, got)
		}
	}
	if checkValue(setting{vartype: "bool"}, "on") != "" || checkValue(setting{vartype: "bool"}, "maybe") == "" {
		t.Error("bool")
	}
	if checkValue(setting{vartype: "enum", enumvals: []string{"warning", "error"}}, "ERROR") != "" {
		t.Error("enum case")
	}
}

func TestIncluded(t *testing.T) {
	conf := []byte("data_directory = '/var/lib/x'\ninclude_dir = 'conf.d'\n")
	if !included(conf, "/etc/postgresql/17/main/postgresql.conf", "/etc/postgresql/17/main/conf.d/90-exponetdb.conf") {
		t.Fatal("conf.d include not seen")
	}
	if included(conf, "/etc/postgresql/17/main/postgresql.conf", "/etc/postgresql/17/main/conf.d/90-exponetdb.txt") {
		t.Fatal("a non-.conf file counted as included")
	}
	if included([]byte("#include_dir = 'conf.d'\n"), "/etc/p/postgresql.conf", "/etc/p/conf.d/a.conf") {
		t.Fatal("a commented include counted")
	}
	if !included([]byte("include_if_exists = '/etc/p/exdb.conf'\n"), "/etc/p/postgresql.conf", "/etc/p/exdb.conf") {
		t.Fatal("an explicit include not seen")
	}
}

func TestAPasswordLiteralOverSeveralLinesIsWithheld(t *testing.T) {
	log := "2026-10-07 21:00:01.000 UTC [101] app@db STATEMENT:  ALTER ROLE x PASSWORD 'first line\n" +
		"second line of the secret'\n" +
		"2026-10-07 21:00:02.000 UTC [102] LOG:  checkpoint starting: time\n" +
		"  a continuation, withheld like every other\n"
	lines := parsePgLog(log, false)
	redactEntries(lines)
	got := []string{}
	for _, l := range lines {
		got = append(got, l.text)
	}
	// A statement's text is withheld whole (it is a client's SQL), with the
	// lines continuing it (Wave 5 correction F1); a continuation line is
	// never shown (correction review: it can be anything).
	want := []string{"STATEMENT:  [withheld]", "[withheld]", "LOG:  checkpoint starting: time", "[withheld]"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("%q", got)
	}
	// The continuation alone (its head cut by maxLines) is still withheld.
	if lines[1].text != "[withheld]" || !lines[1].cont {
		t.Fatalf("%+v", lines[1])
	}
}

// The server log is shown by an allowlist of PostgreSQL's own messages
// (Wave 5 correction review of F1): the error position PostgreSQL appends,
// a value in the middle of a message, a token after "near", a value with a
// quote in it, a name with a colon in the prefix, another log_line_prefix
// and auto_explain's plan lines all leaked through the earlier patterns.
func TestTheServerLogIsShownByItsTemplatesOnly(t *testing.T) {
	const canary = "EXDBCANARYtpl71"
	p := "2026-10-07 21:00:01.000 UTC [101] app@db "
	log := p + "ERROR:  invalid input syntax for type integer: \"" + canary + "\" at character 8\n" +
		p + "ERROR:  syntax error at or near \"'" + canary + "'\" at character 10\n" +
		p + "ERROR:  value \"" + canary + "\" is out of range for type integer\n" +
		p + "ERROR:  invalid input syntax for type uuid: \"a\"" + canary + "\"\n" +
		p + "ERROR:  new feature message quoting " + canary + "\n" +
		"2026-10-07 21:00:02.000 UTC [102] app:x@db ERROR:  invalid input syntax for type integer: " + canary + "\n" +
		"2026-10-07 21:00:02.000 UTC [102] app@db: STATEMENT:  SELECT '" + canary + "'\n" +
		"21:00:03 pid=103 ERROR: " + canary + "\n" +
		p + "LOG:  duration: 0.042 ms  plan:\n" +
		"\tQuery Text: SELECT '" + canary + "'\n" +
		p + "FATAL:  password authentication failed for user \"" + canary + "\"\n" +
		p + "LOG:  connection authorized: user=app database=db application_name=" + canary + "\n" +
		p + "HINT:  " + canary + "\n" +
		"2026-10-07 21:00:04.000 UTC [104] LOG:  received SIGHUP, reloading configuration files\n" +
		"2026-10-07 21:00:04.000 UTC [104] LOG:  parameter \"work_mem\" changed to \"" + canary + "\"\n" +
		"2026-10-07 21:00:05.000 UTC [105] LOG:  checkpoint complete: wrote 3 buffers (0.0%); 0 WAL file(s) added, 0 removed, 0 recycled\n" +
		"2026-10-07 21:00:06.000 UTC [106] LOG:  database system is ready to accept connections\n"
	lines := parsePgLog(log, false)
	redactEntries(lines)
	got := []string{}
	for _, l := range lines {
		if strings.Contains(l.text, canary) {
			t.Errorf("exported: %q", l.text)
		}
		got = append(got, l.text)
	}
	want := []string{
		"ERROR:  invalid input syntax for type integer: [withheld] at character 8",
		"ERROR:  syntax error at or near [withheld] at character 10",
		"ERROR:  value [withheld] is out of range for type integer",
		"ERROR:  [withheld]",
		"ERROR:  [withheld]",
		"[withheld]", "[withheld]", "[withheld]",
		"LOG:  [withheld]", "[withheld]",
		"FATAL:  password authentication failed for user [withheld]",
		"LOG:  connection authorized: [withheld]",
		"HINT:  [withheld]",
		"LOG:  received SIGHUP, reloading configuration files",
		"LOG:  parameter \"work_mem\" changed to [withheld]",
		"LOG:  checkpoint complete: wrote 3 buffers (0.0%); 0 WAL file(s) added, 0 removed, 0 recycled",
		"LOG:  database system is ready to accept connections",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// A client can write any text into the server log in the form of a server
// message (RAISE LOG, RAISE EXCEPTION) or with a level the message never
// has (correction review, round 2): a message only the server writes is
// shown only from a line without a session, with its own level, and a line
// of a session shows a template's fixed words and numbers only.
func TestAServerMessageWrittenByAClientIsNotShown(t *testing.T) {
	const canary = "EXDBCANARYfrg1"
	p := "2026-10-07 21:00:01.000 UTC [101] app@db "
	s := "2026-10-07 21:00:02.000 UTC [102] "
	log := p + "LOG:  checkpoint complete: card 4111 1111 1111 1111 cvv=123 " + canary + "\n" +
		p + "ERROR:  redo done at 0/0 system usage: secret token " + canary + "\n" +
		p + "LOG:  database system is ready to accept connections\n" +
		s + "ERROR:  checkpoint complete: wrote 3 buffers (0.0%)\n" +
		s + "LOG:  checkpoint complete: wrote 3 buffers (0.0%); secret words here\n" +
		s + "LOG:  checkpoint starting: time secretword\n" +
		p + "ERROR:  parameter \"secretword\" cannot be changed now\n" +
		p + "ERROR:  invalid input syntax for type secret words here: \"x\"\n" +
		p + "LOG:  could not receive data from client: Secret Words Here\n" +
		s + "LOG:  server process (PID 7) was terminated by signal 9: Secret Words\n" +
		s + "LOG:  checkpoint complete: wrote 3 buffers (0.0%); 0 WAL file(s) added, 0 removed, 0 recycled; write=0.001 s, sync=0.001 s, total=0.002 s; sync files=2, longest=0.001 s, average=0.001 s; distance=1 kB, estimate=1 kB; lsn=0/1A2B3C, redo lsn=0/1A2B00\n" +
		s + "LOG:  checkpoint starting: immediate force wait\n" +
		s + "LOG:  redo done at 0/1A2B3C system usage: CPU: user: 0.00 s, system: 0.01 s, elapsed: 0.02 s\n" +
		s + "LOG:  parameter \"work_mem\" changed to \"8MB\"\n" +
		p + "ERROR:  invalid input syntax for type integer: \"x\" at character 8\n" +
		p + "LOG:  could not receive data from client: Connection reset by peer\n" +
		s + "LOG:  server process (PID 7) was terminated by signal 9: Killed\n"
	lines := parsePgLog(log, false)
	redactEntries(lines)
	got := []string{}
	for _, l := range lines {
		got = append(got, l.text)
	}
	want := []string{
		"LOG:  [withheld]",
		"ERROR:  [withheld]",
		"LOG:  [withheld]",
		"ERROR:  [withheld]",
		"LOG:  [withheld]",
		"LOG:  [withheld]",
		"ERROR:  parameter [withheld] cannot be changed now",
		"ERROR:  [withheld]",
		"LOG:  [withheld]",
		"LOG:  [withheld]",
		"LOG:  checkpoint complete: wrote 3 buffers (0.0%); 0 WAL file(s) added, 0 removed, 0 recycled; write=0.001 s, sync=0.001 s, total=0.002 s; sync files=2, longest=0.001 s, average=0.001 s; distance=1 kB, estimate=1 kB; lsn=0/1A2B3C, redo lsn=0/1A2B00",
		"LOG:  checkpoint starting: immediate force wait",
		"LOG:  redo done at 0/1A2B3C system usage: CPU: user: 0.00 s, system: 0.01 s, elapsed: 0.02 s",
		"LOG:  parameter \"work_mem\" changed to [withheld]",
		"ERROR:  invalid input syntax for type integer: [withheld] at character 8",
		"LOG:  could not receive data from client: Connection reset by peer",
		"LOG:  server process (PID 7) was terminated by signal 9: Killed",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// A read that begins inside the log file starts inside a line, which may
// be the end of a client's text in the form of a whole line: that first
// piece is never read as a line of its own (correction review, round 2).
func TestTheCutFirstLineOfATailIsDropped(t *testing.T) {
	tail := "2026-10-07 21:00:00.000 UTC [100] LOG:  checkpoint complete: wrote 1 buffers\n" +
		"2026-10-07 21:00:01.000 UTC [101] LOG:  database system is ready to accept connections\n"
	if lines := parsePgLog(tail, true); len(lines) != 1 || lines[0].message != "database system is ready to accept connections" {
		t.Fatalf("%+v", lines)
	}
	if lines := parsePgLog(tail, false); len(lines) != 2 {
		t.Fatalf("%+v", lines)
	}
}

func TestLogParsingAndRedaction(t *testing.T) {
	log := "2026-10-07 21:00:00.123 UTC [100] LOG:  received SIGHUP, reloading configuration files\n" +
		"2026-10-07 21:00:01.000 UTC [101] app@db ERROR:  syntax error\n" +
		"2026-10-07 21:00:01.000 UTC [101] app@db STATEMENT:  ALTER ROLE x PASSWORD 'hunter2'\n" +
		"  continued from 10.1.2.3\n"
	lines := parsePgLog(log, false)
	if len(lines) != 4 || lines[0].at == nil || lines[0].rank != severityRank["info"] || lines[2].rank != severityRank["error"] || !lines[3].cont {
		t.Fatalf("%+v", lines)
	}
	for in, want := range map[string]string{
		"ALTER ROLE x PASSWORD 'hunter2'":                 "ALTER ROLE x PASSWORD [redacted]",
		"ALTER ROLE x PASSWORD E'hun\\'ter2' LOGIN":       "ALTER ROLE x PASSWORD [redacted]",
		"ALTER ROLE x PASSWORD $$hunter2$$":               "ALTER ROLE x PASSWORD [redacted]",
		"ALTER ROLE x PASSWORD $q$hunter2$q$":             "ALTER ROLE x PASSWORD [redacted]",
		"ALTER ROLE x PASSWORD'hunter2'":                  "ALTER ROLE x PASSWORD [redacted]",
		"ALTER ROLE x PASSWORD U&'hunter2'":               "ALTER ROLE x PASSWORD [redacted]",
		"ALTER ROLE x password = 'hunter2'":               "ALTER ROLE x password = [redacted]",
		"dsn postgresql://app:" + "hunter2@db/x":          "dsn postgresql://app:" + "[redacted]@db/x", // split for the repository's secret scan
		`{"user":"a","password":"hun\"ter2"}`:             `{"user":"a","password":"[redacted]"}`,
		"password authentication failed for user \"app\"": "password authentication failed for user \"app\"",
		"host=db password=s3cret user=a":                  "host=db password=[redacted] user=a",
		"SCRAM-SHA-256$4096:abc$def:ghi":                  "[redacted]",
		"md5" + strings.Repeat("a", 32):                   "[redacted]",
		"connection from 10.1.2.3 port 5432":              "connection from [ip] port 5432",
		"token exdbt1.abcDEF_123":                         "token [redacted]",
		"Authorization: Bearer eyJhbGciOi":                "Authorization: Bearer [redacted]",
		`{"verifier":{"ns1":{"enc":"x","ct":"y"}}}`:       `{"verifier":{"ns1":[redacted]}}`,
		"client fe80::1:2:3 connected":                    "client [ip] connected",
	} {
		if got := Redact(in); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}

// TestLogMessagesThatQuoteDataAreWithheld: PostgreSQL quotes values in
// reload, error, statement and detail messages; none of them is exported,
// whatever the word in front of the value (Wave 5 correction F1).
func TestLogMessagesThatQuoteDataAreWithheld(t *testing.T) {
	const canary = "EXDBCANARYlog93"
	log := "2026-10-07 21:00:01.000 UTC [101] LOG:  parameter \"myext.api_key\" changed to \"" + canary + "\"\n" +
		"2026-10-07 21:00:02.000 UTC [102] app@db ERROR:  invalid value for parameter \"work_mem\": \"" + canary + "\"\n" +
		"2026-10-07 21:00:03.000 UTC [103] app@db ERROR:  duplicate key value violates unique constraint \"t_pkey\"\n" +
		"2026-10-07 21:00:03.000 UTC [103] app@db DETAIL:  Key (token)=(" + canary + ") already exists.\n" +
		"2026-10-07 21:00:04.000 UTC [104] app@db LOG:  statement: SELECT set_config('myext.token', '" + canary + "', false)\n" +
		"  , '" + canary + "'\n" +
		"2026-10-07 21:00:05.000 UTC [105] app@db LOG:  duration: 1.234 ms  execute <unnamed>: SELECT $1\n" +
		"2026-10-07 21:00:05.000 UTC [105] app@db DETAIL:  parameters: $1 = '" + canary + "'\n" +
		"2026-10-07 21:00:06.000 UTC [106] app@db ERROR:  invalid input syntax for type integer: \"" + canary + "\"\n" +
		"2026-10-07 21:00:06.000 UTC [106] app@db CONTEXT:  SQL statement \"SELECT '" + canary + "'\"\n" +
		"2026-10-07 21:00:07.000 UTC [107] LOG:  checkpoint complete: wrote 3 buffers\n"
	lines := parsePgLog(log, false)
	redactEntries(lines)
	for _, l := range lines {
		if strings.Contains(l.text, canary) {
			t.Errorf("exported: %q", l.text)
		}
	}
	if last := lines[len(lines)-1].text; last != "LOG:  checkpoint complete: wrote 3 buffers" {
		t.Fatalf("an ordinary line changed: %q", last)
	}
	if first := lines[0].text; first != "LOG:  parameter \"myext.api_key\" changed to [withheld]" {
		t.Fatalf("the parameter name should stay: %q", first)
	}
}

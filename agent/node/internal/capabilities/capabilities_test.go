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
		"  a continuation that stays\n"
	lines := parsePgLog(log)
	redactEntries(lines)
	got := []string{}
	for _, l := range lines {
		got = append(got, l.text)
	}
	want := []string{"STATEMENT:  ALTER ROLE x PASSWORD [redacted]", "[redacted]", "LOG:  checkpoint starting: time", "  a continuation that stays"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("%q", got)
	}
	// The continuation alone (its head cut by maxLines) is still withheld.
	if lines[1].text != "[redacted]" || !lines[1].cont {
		t.Fatalf("%+v", lines[1])
	}
}

func TestLogParsingAndRedaction(t *testing.T) {
	log := "2026-10-07 21:00:00.123 UTC [100] LOG:  received SIGHUP, reloading configuration files\n" +
		"2026-10-07 21:00:01.000 UTC [101] app@db ERROR:  syntax error\n" +
		"2026-10-07 21:00:01.000 UTC [101] app@db STATEMENT:  ALTER ROLE x PASSWORD 'hunter2'\n" +
		"  continued from 10.1.2.3\n"
	lines := parsePgLog(log)
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

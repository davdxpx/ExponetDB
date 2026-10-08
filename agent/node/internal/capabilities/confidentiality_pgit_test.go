//go:build pgit

package capabilities

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgfiles"
)

// F1 (review of Wave 5): nothing a node exports may carry a host secret.
// Every value below is a synthetic canary on a disposable cluster; each
// test fails if the canary appears anywhere in a result, an error or a
// digest input the Control Plane could brute-force.

const canary = "EXDBCANARYc7f3a91e"

// latest is the highest major of a capability the agent implements.
func (h *harness) latest(name string) string {
	best, key := 0, ""
	for k := range h.caps {
		n, major, ok := strings.Cut(k, "@")
		m, err := strconv.Atoi(major)
		if ok && err == nil && n == name && m > best {
			best, key = m, k
		}
	}
	if key == "" {
		h.t.Fatalf("no %s capability", name)
	}
	return key
}

// leaks fails the test when the canary is in the value's canonical bytes.
func leaks(t *testing.T, what string, v canon.Value) {
	t.Helper()
	b, err := canon.Canonicalize(v)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte(canary)) {
		t.Errorf("%s exports the canary: %s", what, b)
	}
}

func errLeaks(t *testing.T, what string, err error) {
	t.Helper()
	if err != nil && strings.Contains(err.Error(), canary) {
		t.Errorf("%s error exports the canary: %v", what, err)
	}
}

// secrets plants the canary where PostgreSQL keeps secrets of its own and of
// extensions: a standard parameter (primary_conninfo, through ALTER SYSTEM),
// a custom parameter in a conf.d file, a role and a database setting, and a
// foreign pg_hba rule with LDAP and RADIUS secrets (parsed only; nothing
// contacts a server). Everything is undone at the end.
func (h *harness) secrets(t *testing.T) {
	t.Helper()
	h.sql(`ALTER SYSTEM SET primary_conninfo = 'host=192.0.2.1 user=replicator password=` + canary + `'`)
	h.sql(`DROP ROLE IF EXISTS exdb_canary_role`)
	h.sql(`CREATE ROLE exdb_canary_role NOLOGIN`)
	h.sql(`ALTER ROLE exdb_canary_role SET exdbcanary.api_token = '` + canary + `'`)
	h.sql(`ALTER ROLE exdb_canary_role IN DATABASE postgres SET application_name = 'app'`)
	h.sql(`ALTER DATABASE postgres SET exdbcanary.db_secret = '` + canary + `'`)
	confd := filepath.Join(filepath.Dir(h.in.ConfigFile), "conf.d")
	custom := filepath.Join(confd, "50-exdb-canary.conf")
	if err := os.WriteFile(custom, []byte("exdbcanary.api_key = '"+canary+"'\n"+
		// A typed parameter with a value that is not of its type: the raw file
		// text must not be shown either.
		"work_mem = '"+canary+"'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	hba, err := os.ReadFile(h.in.HbaFile)
	if err != nil {
		t.Fatal(err)
	}
	foreign := "\n# exdb canary (test)\n" +
		"host all exdb_canary_role 192.0.2.0/24 ldap ldapserver=ldap.invalid ldapbasedn=\"dc=example\" ldapbinddn=\"cn=reader\" ldapbindpasswd=" + canary + " ldapsearchattribute=uid\n" +
		"host all exdb_canary_role 198.51.100.0/24 radius radiusservers=radius.invalid radiussecrets=" + canary + "\n"
	if err := os.WriteFile(h.in.HbaFile, append(append([]byte{}, hba...), foreign...), 0o640); err != nil {
		t.Fatal(err)
	}
	h.sql(`SELECT pg_reload_conf()`)
	t.Cleanup(func() {
		_ = os.WriteFile(h.in.HbaFile, hba, 0o640)
		_ = os.Remove(custom)
		h.sql(`ALTER SYSTEM RESET primary_conninfo`)
		h.sql(`ALTER DATABASE postgres RESET exdbcanary.db_secret`)
		h.sql(`DROP ROLE IF EXISTS exdb_canary_role`)
		h.sql(`SELECT pg_reload_conf()`)
	})
}

func TestNoHostSecretLeavesTheNode(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		h.secrets(t)

		inspect := h.must(h.latest("postgres.config.inspect"), obj("cluster", cl))
		leaks(t, "postgres.config.inspect", inspect)

		plan := h.must(h.latest("postgres.config.plan"), obj("cluster", cl, "changes", canon.Array{
			obj("name", "exdbcanary.api_key", "value", "x"),
			obj("name", "work_mem", "value", "8MB"),
		}))
		leaks(t, "postgres.config.plan", plan)

		roles := h.must(h.latest("postgres.roles.inspect"), obj("cluster", cl, "expectSettings", canon.Array{
			obj("role", "exdb_canary_role", "database", nil, "name", "exdbcanary.api_token", "value", canary),
			obj("role", "exdb_canary_role", "database", nil, "name", "exdbcanary.api_token", "value", "a guess"),
		}))
		leaks(t, "postgres.roles.inspect", roles)
		// The host compares an expected value without exporting the value.
		if got := mustJSON(member(roles, "expectations")); got != `[{"holds":true},{"holds":false}]` {
			t.Errorf("expectations %s", got)
		}
		// A withheld value is a marker, never null or a value as if read.
		for _, item := range list(roles, "settings") {
			s, _ := item.(canon.Object)
			if text(s, "name") == "exdbcanary.api_token" && mustJSON(member(s, "value")) != `{"withheld":"unclassified"}` {
				t.Errorf("custom setting %s", mustJSON(s))
			}
		}

		hba := h.must(h.latest("postgres.hba.inspect"), obj("cluster", cl))
		leaks(t, "postgres.hba.inspect", hba)

		reload, err := h.run(h.latest("postgres.reload"), h.job(h.latest("postgres.reload"), obj("cluster", cl)))
		errLeaks(t, "postgres.reload", err)
		if err == nil {
			leaks(t, "postgres.reload", reload)
		}
	})
}

// The PostgreSQL error text of a failed statement can quote a value: it never
// reaches an error the agent states.
func TestServerErrorsAreNotExported(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		c, err := h.env.connect(context.Background(), h.in, "")
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		err = c.Exec(context.Background(), `SET work_mem = '`+canary+`'`)
		if err == nil {
			t.Fatal("an invalid value was accepted")
		}
		errLeaks(t, "pgwire", err)
		var pe interface{ Unwrap() error }
		_ = errors.As(err, &pe)
	})
}

// TestWithheldValuesStayUsefulAndBound: shown values stay shown; a change of a
// withheld value makes a plan stale; an unrelated change through the managed
// fragment keeps a value the node withholds on the host, byte for byte,
// without it travelling in a job; errors that quote the file are withheld.
func TestWithheldValuesStayUsefulAndBound(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		h.secrets(t)
		inspect := h.must(h.latest("postgres.config.inspect"), obj("cluster", cl))
		shown := map[string]string{}
		for _, item := range list(inspect, "settings") {
			s, _ := item.(canon.Object)
			shown[text(s, "name")] = mustJSON(member(s, "setting"))
		}
		// A custom parameter only a file names (no extension registered it)
		// and a typed parameter whose file text is not of its type.
		for _, item := range list(inspect, "fileSettings") {
			f, _ := item.(canon.Object)
			if strings.HasSuffix(text(f, "sourcefile"), "50-exdb-canary.conf") {
				shown["file:"+text(f, "name")] = mustJSON(member(f, "setting"))
			}
		}
		for name, want := range map[string]string{
			"primary_conninfo": `{"withheld":"secret"}`, "archive_command": `{"withheld":"secret"}`,
			"file:exdbcanary.api_key": `{"withheld":"unclassified"}`, "file:work_mem": `{"withheld":"unclassified"}`,
		} {
			if shown[name] != want {
				t.Errorf("%s: %s, want %s", name, shown[name], want)
			}
		}
		for _, name := range []string{"work_mem", "max_connections", "search_path", "log_min_messages", "ssl"} {
			if !strings.HasPrefix(shown[name], `"`) {
				t.Errorf("%s is not shown: %s", name, shown[name])
			}
		}
		hba := h.must(h.latest("postgres.hba.inspect"), obj("cluster", cl))
		var ldap canon.Object
		for _, item := range list(hba, "rules") {
			r, _ := item.(canon.Object)
			if text(r, "authMethod") == "ldap" {
				ldap = r
			}
		}
		if got := mustJSON(member(ldap, "options")); !strings.Contains(got, `{"name":"ldapserver","value":"ldap.invalid"}`) ||
			!strings.Contains(got, `{"name":"ldapbindpasswd","value":{"withheld":"secret"}}`) {
			t.Errorf("ldap options %s", got)
		}

		// A withheld value changes: the keyed version changes, so a plan made
		// before is stale (drift is never hidden by the withholding).
		h.sql(`ALTER SYSTEM SET primary_conninfo = 'host=192.0.2.1 user=replicator password=` + canary + `x'`)
		again := h.must(h.latest("postgres.config.inspect"), obj("cluster", cl))
		if text(again, "configVersion") == text(inspect, "configVersion") {
			t.Fatal("a change of a withheld value did not change configVersion")
		}
		if !strings.HasPrefix(text(again, "configVersion"), "kd1:") {
			t.Fatalf("configVersion %s", text(again, "configVersion"))
		}
		include, _ := member(inspect, "managedInclude").(canon.Object)
		stale := obj("cluster", cl, "changes", canon.Array{obj("name", "work_mem", "value", "12MB")},
			"expectedFragmentDigest", member(include, "digest"), "configVersion", text(inspect, "configVersion"), "reload", true)
		if _, err := h.run(h.latest("postgres.config.apply"), h.job(h.latest("postgres.config.apply"), stale)); !errors.Is(err, ErrPrecondition) {
			t.Fatalf("a plan made before a withheld value changed was applied: %v", err)
		}

		// A value the node withholds in the managed fragment (written there
		// by an earlier change) stays on the host when another parameter
		// changes; no job carries it.
		frag := h.in.ManagedInclude
		original, _ := os.ReadFile(frag)
		t.Cleanup(func() {
			if original == nil {
				_ = os.Remove(frag)
			} else {
				_ = os.WriteFile(frag, original, 0o640)
			}
			h.sql(`SELECT pg_reload_conf()`)
		})
		base, err := pgfilesRender([2]string{"exdbcanary.fragment_token", canary}, [2]string{"work_mem", "4MB"})
		if err != nil {
			t.Fatal(err)
		}
		writeFileAs(h, frag, base)
		now := h.must(h.latest("postgres.config.inspect"), obj("cluster", cl))
		leaks(t, "postgres.config.inspect with a withheld fragment value", now)
		inc, _ := member(now, "managedInclude").(canon.Object)
		apply := obj("cluster", cl, "changes", canon.Array{obj("name", "work_mem", "value", "12MB")},
			"expectedFragmentDigest", member(inc, "digest"), "configVersion", text(now, "configVersion"), "reload", true)
		job := h.job(h.latest("postgres.config.apply"), apply)
		leaks(t, "the config.apply job", job.Envelope)
		out, err := h.run(h.latest("postgres.config.apply"), job)
		if err != nil {
			t.Fatal(err)
		}
		leaks(t, "postgres.config.apply", out)
		written, _ := os.ReadFile(frag)
		want, _ := pgfilesRender([2]string{"exdbcanary.fragment_token", canary}, [2]string{"work_mem", "12MB"})
		if !bytes.Equal(written, want) {
			t.Fatalf("the unchanged host value was not kept: %q", written)
		}
		// The plan verifies what it requested on the host, without the value.
		plan := h.must(h.latest("postgres.config.plan"), obj("cluster", cl, "changes", canon.Array{
			obj("name", "work_mem", "value", "12MB"), obj("name", "exdbcanary.fragment_token", "value", "a guess")}))
		leaks(t, "postgres.config.plan", plan)
		states := []string{}
		for _, p := range list(plan, "parameters") {
			o, _ := p.(canon.Object)
			m, _ := member(o, "managed").(canon.Object)
			states = append(states, text(m, "state"))
		}
		if strings.Join(states, ",") != "requested,other" {
			t.Fatalf("managed states %v", states)
		}

		// An include whose file name holds the canary: PostgreSQL quotes the
		// name in pg_file_settings.error; the node withholds the message.
		bad := filepath.Join(filepath.Dir(h.in.ConfigFile), "conf.d", "55-exdb-include.conf")
		if err := os.WriteFile(bad, []byte("include '"+canary+"-missing.conf'\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Remove(bad) })
		reload, err := h.run(h.latest("postgres.reload"), h.job(h.latest("postgres.reload"), obj("cluster", cl)))
		errLeaks(t, "postgres.reload", err)
		if err == nil {
			leaks(t, "postgres.reload", reload)
			if !strings.Contains(mustJSON(reload), `"error":{"withheld":"unclassified"}`) {
				t.Errorf("the quoted error is not reported as withheld: %s", mustJSON(reload))
			}
		}
		withError := h.must(h.latest("postgres.config.inspect"), obj("cluster", cl))
		leaks(t, "postgres.config.inspect with a quoting error", withError)
		found := false
		for _, item := range list(withError, "fileSettings") {
			f, _ := item.(canon.Object)
			if text(f, "sourcefile") == bad {
				found = true
				if mustJSON(member(f, "error")) != `{"withheld":"unclassified"}` {
					t.Errorf("the quoting error is not withheld: %s", mustJSON(f))
				}
			}
		}
		if !found {
			t.Error("the include error is not reported")
		}
	})
}

// pgfilesRender is the managed fragment ExponetDB writes.
func pgfilesRender(params ...[2]string) ([]byte, error) {
	var list []pgfiles.Parameter
	for _, p := range params {
		list = append(list, pgfiles.Parameter{Name: p[0], Value: p[1]})
	}
	return pgfiles.RenderFragment(list)
}

// The server log after real client errors and a failed login (Wave 5
// correction review of F1): PostgreSQL quotes the client's values, appends
// the error position and logs the user name a client sent; log.inspect@2
// shows none of it, and still shows the server's own messages.
func TestServerLogOfClientErrorsHoldsNoClientValue(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		since := time.Now().Add(-2 * time.Second).UTC().Format(time.RFC3339Nano)
		c, err := h.env.connect(context.Background(), h.in, "")
		if err != nil {
			t.Fatal(err)
		}
		for _, q := range []string{
			`SELECT '` + canary + `'::int`,
			`SELECT 1 '` + canary + `'`,
			`SELECT '` + canary + `'::uuid`,
			`SELECT 2147483647 + ` + strings.Repeat("9", 12) + `::int`,
			`SELECT * FROM "` + canary + `"`,
		} {
			if _, err := c.Query(context.Background(), q); err == nil {
				t.Fatalf("%s succeeded", q)
			}
		}
		_ = c.Close()
		// A client that sent its password as the user name.
		cmd := exec.Command("psql", "-Atc", "SELECT 1", fmt.Sprintf("host=127.0.0.1 port=%d user=%s dbname=postgres", h.in.Port, canary))
		cmd.Env = append(os.Environ(), "PGPASSWORD=x", "PGCONNECT_TIMEOUT=5")
		if err := cmd.Run(); err == nil {
			t.Fatal("the login succeeded")
		}
		h.sql(`SELECT pg_catalog.pg_reload_conf()`)
		time.Sleep(500 * time.Millisecond)
		until := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
		logs := h.must("log.inspect@2", obj("source", "postgresql", "cluster", cl, "since", since, "until", until,
			"minSeverity", "debug", "maxLines", 500))
		b, _ := canon.Canonicalize(logs)
		if bytes.Contains(b, []byte(canary)) {
			t.Fatalf("the log result holds the canary: %s", b)
		}
		seen := map[string]bool{}
		for _, l := range list(logs, "lines") {
			line := text(l.(canon.Object), "text")
			for _, s := range []string{"invalid input syntax for type integer: [withheld]", "syntax error at or near [withheld]",
				"password authentication failed for user [withheld]", "received SIGHUP"} {
				if strings.Contains(line, s) {
					seen[s] = true
				}
			}
		}
		if len(seen) != 4 {
			t.Fatalf("the server's own messages are missing (%v): %s", seen, b)
		}
	})
}

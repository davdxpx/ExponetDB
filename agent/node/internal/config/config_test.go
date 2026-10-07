package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const valid = `{
  "schema": "exponetdb.node-config/v1",
  "stateDirectory": "/var/lib/exponetdb-node",
  "helperSocket": "/run/exponetdb-node/helper.sock",
  "disabledCapabilities": ["packages.plan_update@1"],
  "instances": [
    {
      "localName": "17/main",
      "unit": "postgresql@17-main.service",
      "port": 5432,
      "socketDirectory": "/var/run/postgresql",
      "dataDirectory": "/var/lib/postgresql/17/main",
      "configFile": "/etc/postgresql/17/main/postgresql.conf",
      "hbaFile": "/etc/postgresql/17/main/pg_hba.conf",
      "managedInclude": "/etc/postgresql/17/main/conf.d/99-exponetdb.conf"
    }
  ]
}`

func TestParseValid(t *testing.T) {
	c, err := Parse([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	if in, ok := c.Instance("17/main"); !ok || in.Port != 5432 {
		t.Fatalf("instance %+v", in)
	}
	if !c.Disabled("packages.plan_update@1") || c.Disabled("postgres.status@1") {
		t.Fatal("disabled capabilities")
	}
	withHelper := strings.Replace(strings.Replace(valid, `"schema"`, `"agentUser": "exponetdb", "schema"`, 1),
		`"managedInclude"`, `"tlsCertificateFile": "/etc/postgresql/17/main/server.crt", `+
			`"tlsKeyFile": "/etc/postgresql/17/main/server.key", "managedInclude"`, 1)
	c, err = Parse([]byte(withHelper))
	if err != nil || c.AgentUser != "exponetdb" || c.Instances[0].TLSKeyFile != "/etc/postgresql/17/main/server.key" {
		t.Fatalf("helper settings %+v %v", c, err)
	}
}

func TestParseRefuses(t *testing.T) {
	for name, edit := range map[string][2]string{
		"unknown member":   {`"schema"`, `"extra": 1, "schema"`},
		"duplicate member": {`"schema"`, `"schema": "x", "schema"`},
		"wrong schema":     {`node-config/v1`, `node-config/v2`},
		"relative state":   {`"/var/lib/exponetdb-node"`, `"var/lib/exponetdb-node"`},
		"unclean path":     {`"/var/lib/exponetdb-node"`, `"/var/lib/../exponetdb-node"`},
		"bad unit":         {`postgresql@17-main.service`, `sshd.service`},
		"bad port":         {`5432`, `0`},
		"bad local name":   {`"localName": "17/main"`, `"localName": "main"`},
		"bad capability":   {`packages.plan_update@1`, `packages.plan_update`},
		"relative hba":     {`"/etc/postgresql/17/main/pg_hba.conf"`, `"pg_hba.conf"`},
		"trailing data":    {"}\n  ]\n}", "}\n  ]\n}{}"},
		"agent user":       {`"schema"`, `"agentUser": "Exponet DB", "schema"`},
		"agent user path":  {`"schema"`, `"agentUser": "../root", "schema"`},
		"tls cert only": {`"managedInclude"`,
			`"tlsCertificateFile": "/etc/postgresql/17/main/server.crt", "managedInclude"`},
		"tls relative": {`"managedInclude"`,
			`"tlsCertificateFile": "server.crt", "tlsKeyFile": "/etc/postgresql/17/main/server.key", "managedInclude"`},
	} {
		data := strings.Replace(valid, edit[0], edit[1], 1)
		if data == valid {
			t.Fatalf("%s: edit did not apply", name)
		}
		if _, err := Parse([]byte(data)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestLoadChecksOwnerAndMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(valid), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path, Options{OwnerUID: os.Getuid()}); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path, Options{OwnerUID: os.Getuid() + 1}); err == nil {
		t.Error("accepted a file of another owner")
	}
	if err := os.Chmod(path, 0o666); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path, Options{OwnerUID: os.Getuid()}); err == nil {
		t.Error("accepted a world-writable file")
	}
}

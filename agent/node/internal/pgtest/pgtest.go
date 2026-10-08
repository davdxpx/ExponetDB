// Package pgtest gives the node agent's integration tests (build tag pgit)
// the disposable PostgreSQL clusters of tooling/dev/node-clusters.sh, in the
// shape of the operator configuration.
package pgtest

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
)

// Env names the clusters file.
const Env = "EXDB_NODE_CLUSTERS"

// Instances returns the test clusters; without them the test fails (an
// integration test is never skipped).
func Instances(t testing.TB) []config.Instance {
	t.Helper()
	path := os.Getenv(Env)
	if path == "" {
		t.Fatalf("%s is not set: run `eval \"$(sudo tooling/dev/node-clusters.sh)\"` (local-development.md)", Env)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []config.Instance
	if err := json.Unmarshal(data, &out); err != nil || len(out) == 0 {
		t.Fatalf("%s: %v", path, err)
	}
	return out
}

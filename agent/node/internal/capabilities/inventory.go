package capabilities

import (
	"context"
	"regexp"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
)

var versionRE = regexp.MustCompile(`^[1-9][0-9]*\.[0-9]+`)

// Inventory reports the operator-mapped instances that answer, with their
// system identifier and version, for hello (protocol.md §2). An instance
// that does not answer is left out rather than reported without an
// identity.
func Inventory(e *Env) func() []protocol.LocalCluster {
	return func() []protocol.LocalCluster {
		out := []protocol.LocalCluster{}
		for _, in := range e.Config.Instances {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			c, err := e.connect(ctx, in, "")
			if err != nil {
				cancel()
				continue
			}
			rows, err := c.Query(ctx, `SELECT system_identifier::text AS id, current_setting('server_version') AS version
				FROM pg_catalog.pg_control_system()`)
			_ = c.Close()
			cancel()
			if err != nil {
				continue
			}
			r := rows.Each()[0]
			v := versionRE.FindString(r.Text("version"))
			if v == "" {
				continue
			}
			out = append(out, protocol.LocalCluster{
				LocalName: in.LocalName, Port: int64(in.Port), Running: true,
				SystemIdentifier: r.Text("id"), Version: v, DataDirectory: in.DataDirectory,
			})
		}
		return out
	}
}

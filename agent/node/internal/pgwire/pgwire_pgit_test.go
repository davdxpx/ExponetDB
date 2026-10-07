//go:build pgit

package pgwire_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/pgtest"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgwire"
)

func connect(t *testing.T, port int, socket string) *pgwire.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := pgwire.Connect(ctx, pgwire.Options{SocketDirectory: socket, Port: port, User: "exponetdb_node", Database: "postgres"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestQueriesOnEveryMajor(t *testing.T) {
	for _, in := range pgtest.Instances(t) {
		t.Run(in.LocalName, func(t *testing.T) {
			c := connect(t, in.Port, in.SocketDirectory)
			ctx := context.Background()
			if !strings.HasPrefix(c.Parameter("server_version"), in.LocalName[:2]) {
				t.Fatalf("server_version %q", c.Parameter("server_version"))
			}
			rows, err := c.Query(ctx, `SELECT $1::text AS a, $2::int AS b, $3::text AS n, current_setting('search_path') AS sp, current_user AS u`,
				"it's \\ text", 42, nil)
			if err != nil {
				t.Fatal(err)
			}
			r := rows.Each()[0]
			if r.Text("a") != "it's \\ text" || r.Int("b") != 42 || !r.Null("n") || r.Text("sp") != "pg_catalog" || r.Text("u") != "exponetdb_node" {
				t.Fatalf("%+v", rows)
			}
			// A parameter is a value, never SQL.
			rows, err = c.Query(ctx, `SELECT count(*) AS n FROM pg_roles WHERE rolname = $1`, "x' OR '1'='1")
			if err != nil || rows.Each()[0].Int("n") != 0 {
				t.Fatalf("%v %+v", err, rows)
			}
			// Errors carry their SQLSTATE; the session goes on.
			_, err = c.Query(ctx, `SELECT 1/0`)
			var pe *pgwire.Error
			if !errors.As(err, &pe) || pe.Code != "22012" {
				t.Fatalf("%v", err)
			}
			if _, err := c.Query(ctx, `SELECT 1`); err != nil {
				t.Fatal(err)
			}
			// A transaction block.
			if err := c.Exec(ctx, "BEGIN"); err != nil || !c.InTransaction() {
				t.Fatal("no transaction")
			}
			if err := c.Exec(ctx, "ROLLBACK"); err != nil || c.InTransaction() {
				t.Fatal("transaction left open")
			}
			// A context that ends cancels the statement on the server.
			cctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
			start := time.Now()
			_, err = c.Query(cctx, `SELECT pg_sleep(30)`)
			cancel()
			if err == nil || time.Since(start) > 10*time.Second {
				t.Fatalf("not canceled: %v", err)
			}
		})
	}
}

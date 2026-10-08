// Package capabilities is the node agent's capability catalog (Wave 5
// Phase 5, capabilities.md): typed, versioned operations on the local
// PostgreSQL instances the operator mapped and on the host. SQL is compiled
// here with every value bound or escaped; host changes go through the root
// helper, which verifies the same signed job itself. No capability takes SQL,
// a command, a script or a path from a job.
package capabilities

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgwire"
)

// Helper calls the root helper with the signed job envelope.
type Helper interface {
	Call(ctx context.Context, op string, envelope canon.Object) (canon.Object, error)
}

// Env is what the capabilities share.
type Env struct {
	Config *config.Config
	Helper Helper
	Clock  clock.Clock
	// Role is the agent's PostgreSQL role (security.md §3).
	Role string
	// Root prefixes host paths read by the agent itself (/proc, /var/run) in
	// tests; "" in production.
	Root string
	// TLSDial reaches an instance's TCP port for the presented-certificate
	// check (127.0.0.1 by default).
	TLSHost string
	// DigestKey keys the agent's digests over state that may hold a withheld
	// value (kd1, capabilities.md §6): derived from the node encryption
	// secret, never stored or sent. Without it no such digest is exported.
	DigestKey []byte
}

// DefaultRole is the agent's PostgreSQL role.
const DefaultRole = "exponetdb_node"

// ErrPrecondition is a local fact that does not match the job.
var ErrPrecondition = errors.New("precondition_failed")

func preconditionf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrPrecondition, fmt.Sprintf(format, args...))
}

func (e *Env) role() string {
	if e.Role == "" {
		return DefaultRole
	}
	return e.Role
}

func (e *Env) now() time.Time { return e.Clock.Now().UTC() }

// clusterRef reads args.cluster.
func clusterRef(args canon.Object) (localName, systemIdentifier string) {
	c, _ := member(args, "cluster").(canon.Object)
	return text(c, "localName"), text(c, "systemIdentifier")
}

// instance resolves a job's cluster to the operator's mapping.
func (e *Env) instance(args canon.Object) (config.Instance, error) {
	name, _ := clusterRef(args)
	in, ok := e.Config.Instance(name)
	if !ok {
		return config.Instance{}, preconditionf("cluster %s is not mapped by the operator", name)
	}
	return in, nil
}

// connect opens a session as the agent's role over the instance's socket.
func (e *Env) connect(ctx context.Context, in config.Instance, database string) (*pgwire.Conn, error) {
	if database == "" {
		database = "postgres"
	}
	return pgwire.Connect(ctx, pgwire.Options{
		SocketDirectory: in.SocketDirectory, Port: in.Port, User: e.role(), Database: database,
	})
}

// session opens the job's cluster after checking its system identifier.
func (e *Env) session(ctx context.Context, args canon.Object, database string) (config.Instance, *pgwire.Conn, error) {
	in, err := e.instance(args)
	if err != nil {
		return in, nil, err
	}
	c, err := e.connect(ctx, in, database)
	if err != nil {
		return in, nil, err
	}
	if err := e.checkIdentity(ctx, c, args); err != nil {
		_ = c.Close()
		return in, nil, err
	}
	return in, c, nil
}

func (e *Env) checkIdentity(ctx context.Context, c *pgwire.Conn, args canon.Object) error {
	_, want := clusterRef(args)
	rows, err := c.Query(ctx, `SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()`)
	if err != nil {
		return err
	}
	if got := rows.Each()[0].Text("id"); got != want {
		return preconditionf("the local cluster has another system identifier")
	}
	return nil
}

// clusterPrecondition is the instance binding of every cluster-bound
// capability (capabilities.md §2): mapped, reachable, the same system
// identifier (protocol.md §4.2 step 7).
func (e *Env) clusterPrecondition(args canon.Object) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, c, err := e.session(ctx, args, "")
	if err != nil {
		if errors.Is(err, ErrPrecondition) {
			return err
		}
		return preconditionf("the cluster cannot be reached")
	}
	return c.Close()
}

// ----- result building -----

func member(o canon.Object, name string) canon.Value { v, _ := o.Get(name); return v }

func text(o canon.Object, name string) string {
	s, _ := member(o, name).(canon.String)
	return string(s)
}

func textOrNil(o canon.Object, name string) *string {
	s, ok := member(o, name).(canon.String)
	if !ok {
		return nil
	}
	v := string(s)
	return &v
}

func boolOf(o canon.Object, name string) bool {
	b, _ := member(o, name).(canon.Bool)
	return bool(b)
}

func list(o canon.Object, name string) canon.Array {
	a, _ := member(o, name).(canon.Array)
	return a
}

// val converts Go values into canonical JSON values.
func val(v any) canon.Value {
	switch x := v.(type) {
	case nil:
		return canon.Null{}
	case canon.Value:
		return x
	case string:
		return canon.String(x)
	case *string:
		if x == nil {
			return canon.Null{}
		}
		return canon.String(*x)
	case bool:
		return canon.Bool(x)
	case int:
		return canon.Number(x)
	case int64:
		return canon.Number(x)
	case float64:
		return canon.Number(x)
	case []string:
		a := make(canon.Array, 0, len(x))
		for _, s := range x {
			a = append(a, canon.String(s))
		}
		return a
	case time.Time:
		if x.IsZero() {
			return canon.Null{}
		}
		return canon.String(x.UTC().Format(time.RFC3339Nano))
	case *time.Time:
		if x == nil {
			return canon.Null{}
		}
		return canon.String(x.UTC().Format(time.RFC3339Nano))
	}
	panic(fmt.Sprintf("capabilities: no canonical value for %T", v))
}

// obj builds an object from name/value pairs.
func obj(pairs ...any) canon.Object {
	o := make(canon.Object, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		o = append(o, canon.Member{Name: pairs[i].(string), Value: val(pairs[i+1])})
	}
	return o
}

// digest is the contract digest of a canonical value.
func digest(v canon.Value) (string, error) {
	b, err := canon.Canonicalize(v)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

// bound keeps host or server text within a contract length (UTF-8 safe).
func bound(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && n < len(s) && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n]
}

// pgTime parses a PostgreSQL timestamptz in ISO style.
func pgTime(s string) (time.Time, bool) {
	for _, layout := range []string{"2006-01-02 15:04:05.999999-07", "2006-01-02 15:04:05.999999-07:00", "2006-01-02 15:04:05-07"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// quoteIdent quotes a PostgreSQL identifier.
func quoteIdent(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

// quoteLiteral quotes a string literal (standard_conforming_strings on).
func quoteLiteral(s string) string { return `'` + strings.ReplaceAll(s, `'`, `''`) + `'` }

// fixed is the common part of a capability.
type fixed struct {
	key, effect string
	env         *Env
}

func (f fixed) Key() string        { return f.key }
func (f fixed) EffectStep() string { return f.effect }

// clusterBound adds the instance binding as precondition.
type clusterBound struct{ fixed }

func (c clusterBound) Precondition(args canon.Object) error { return c.env.clusterPrecondition(args) }

// unbound is a capability with no local precondition.
type unbound struct{ fixed }

func (unbound) Precondition(canon.Object) error { return nil }

// step records a succeeded step.
func step(run *agent.Run, name string) error { return run.Step(name, "succeeded", nil) }

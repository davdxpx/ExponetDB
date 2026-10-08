// Package pgwire is the node agent's PostgreSQL client (architecture.md §2,
// security.md §3): protocol 3.0 over the local Unix socket only, `peer`
// authentication only (the agent holds no PostgreSQL credential), the
// extended query protocol with every value bound as a parameter, text
// results. It runs only SQL compiled into the capabilities; it has no way
// to take SQL text from a job.
//
// The agent module uses the standard library only, so this is a small
// clean-room implementation of the documented protocol
// (https://www.postgresql.org/docs/current/protocol.html).
package pgwire

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	protocolVersion = 196608 // 3.0
	cancelCode      = 80877102
	// maxMessage bounds one backend message (a row, an error).
	maxMessage = 64 << 20
)

// Error is a PostgreSQL error: its severity and SQLSTATE only. The server's
// message, detail and hint are not kept: PostgreSQL quotes values in them
// (`invalid value for parameter "x": "..."`, a key, a parameter of the
// statement), and every error the agent states, notes or logs can leave the
// host (Wave 5 correction F1, capabilities.md §6).
type Error struct {
	Severity string
	Code     string
}

func (e *Error) Error() string { return "postgres error " + e.Code + " (" + e.Severity + ")" }

// ErrAuthentication: the server asked for a credential; the agent uses peer
// authentication only.
var ErrAuthentication = errors.New("pgwire: the server asked for a password; only peer authentication is supported")

// Options name the local instance and the role.
type Options struct {
	// SocketDirectory and Port locate the socket <dir>/.s.PGSQL.<port>.
	SocketDirectory string
	Port            int
	User            string
	Database        string
	// StatementTimeout bounds every statement on the server (0: 60 s).
	StatementTimeout time.Duration
}

// Conn is one session. It is not safe for concurrent use.
type Conn struct {
	mu        sync.Mutex
	c         net.Conn
	r         *bufio.Reader
	o         Options
	pid       int32
	secret    int32
	params    map[string]string
	broken    error
	txStatus  byte
	closeOnce sync.Once
}

// SocketPath is the socket of the instance.
func (o Options) SocketPath() string {
	return strings.TrimSuffix(o.SocketDirectory, "/") + "/.s.PGSQL." + strconv.Itoa(o.Port)
}

// Connect opens a session and authenticates by peer.
func Connect(ctx context.Context, o Options) (*Conn, error) {
	if o.StatementTimeout <= 0 {
		o.StatementTimeout = 60 * time.Second
	}
	var d net.Dialer
	nc, err := d.DialContext(ctx, "unix", o.SocketPath())
	if err != nil {
		return nil, fmt.Errorf("pgwire: connect: %w", err)
	}
	c := &Conn{c: nc, r: bufio.NewReaderSize(nc, 32*1024), o: o, params: map[string]string{}}
	stop := c.watch(ctx)
	defer stop()
	if err := c.startup(); err != nil {
		_ = nc.Close()
		return nil, err
	}
	return c, nil
}

// watch applies the context's deadline and cancels the running statement
// when the context ends.
func (c *Conn) watch(ctx context.Context) func() {
	if deadline, ok := ctx.Deadline(); ok {
		_ = c.c.SetDeadline(deadline)
	} else {
		_ = c.c.SetDeadline(time.Time{})
	}
	stop := context.AfterFunc(ctx, func() {
		c.cancel()
		_ = c.c.SetDeadline(time.Unix(1, 0))
	})
	return func() { stop() }
}

func (c *Conn) startup() error {
	params := []string{
		"user", c.o.User,
		"database", c.o.Database,
		"application_name", "exponetdb-node",
		"client_encoding", "UTF8",
		"DateStyle", "ISO",
		// Compiled SQL names its schemas; pg_catalog first, nothing else.
		// Literals are quoted for standard_conforming_strings, whatever the
		// cluster's configuration says.
		"options", "-c search_path=pg_catalog -c standard_conforming_strings=on -c statement_timeout=" +
			strconv.FormatInt(c.o.StatementTimeout.Milliseconds(), 10),
	}
	body := make([]byte, 0, 256)
	body = binary.BigEndian.AppendUint32(body, protocolVersion)
	for _, p := range params {
		if strings.IndexByte(p, 0) >= 0 {
			return errors.New("pgwire: a startup parameter contains NUL")
		}
		body = append(append(body, p...), 0)
	}
	body = append(body, 0)
	msg := binary.BigEndian.AppendUint32(nil, uint32(len(body)+4))
	if _, err := c.c.Write(append(msg, body...)); err != nil {
		return err
	}
	for {
		t, data, err := c.read()
		if err != nil {
			return err
		}
		switch t {
		case 'R':
			if len(data) < 4 {
				return errors.New("pgwire: short authentication message")
			}
			if binary.BigEndian.Uint32(data) != 0 {
				return ErrAuthentication
			}
		case 'S':
			k, v := cstrings2(data)
			c.params[k] = v
		case 'K':
			if len(data) >= 8 {
				c.pid = int32(binary.BigEndian.Uint32(data))
				c.secret = int32(binary.BigEndian.Uint32(data[4:]))
			}
		case 'E':
			return parseError(data)
		case 'N':
		case 'Z':
			if len(data) > 0 {
				c.txStatus = data[0]
			}
			return nil
		default:
			return fmt.Errorf("pgwire: unexpected message %q during startup", t)
		}
	}
}

// Parameter returns a server parameter reported at startup or since
// (server_version, ...).
func (c *Conn) Parameter(name string) string { return c.params[name] }

// cancel sends a CancelRequest on a separate connection.
func (c *Conn) cancel() {
	nc, err := net.DialTimeout("unix", c.o.SocketPath(), 2*time.Second)
	if err != nil {
		return
	}
	defer nc.Close()
	msg := binary.BigEndian.AppendUint32(nil, 16)
	msg = binary.BigEndian.AppendUint32(msg, cancelCode)
	msg = binary.BigEndian.AppendUint32(msg, uint32(c.pid))
	msg = binary.BigEndian.AppendUint32(msg, uint32(c.secret))
	_ = nc.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = nc.Write(msg)
}

func (c *Conn) read() (byte, []byte, error) {
	var head [5]byte
	if _, err := io.ReadFull(c.r, head[:]); err != nil {
		return 0, nil, err
	}
	n := int(binary.BigEndian.Uint32(head[1:]))
	if n < 4 || n-4 > maxMessage {
		return 0, nil, errors.New("pgwire: message length out of range")
	}
	data := make([]byte, n-4)
	if _, err := io.ReadFull(c.r, data); err != nil {
		return 0, nil, err
	}
	return head[0], data, nil
}

func cstring(data []byte) (string, []byte) {
	i := 0
	for i < len(data) && data[i] != 0 {
		i++
	}
	if i == len(data) {
		return string(data), nil
	}
	return string(data[:i]), data[i+1:]
}

func cstrings2(data []byte) (string, string) {
	a, rest := cstring(data)
	b, _ := cstring(rest)
	return a, b
}

func parseError(data []byte) *Error {
	e := &Error{}
	for len(data) > 0 && data[0] != 0 {
		field := data[0]
		var v string
		v, data = cstring(data[1:])
		switch field {
		case 'V':
			e.Severity = v
		case 'S':
			if e.Severity == "" {
				e.Severity = v
			}
		case 'C':
			e.Code = v
		}
	}
	return e
}

func message(t byte, body []byte) []byte {
	out := []byte{t}
	out = binary.BigEndian.AppendUint32(out, uint32(len(body)+4))
	return append(out, body...)
}

// Rows is a statement's result: column names, text values (nil is NULL)
// and the command tag.
type Rows struct {
	Columns []string
	Values  [][]*string
	Command string
}

// Row is one row with access by column name.
type Row struct {
	cols map[string]int
	vals []*string
}

// Each returns the rows by column name.
func (r *Rows) Each() []Row {
	cols := make(map[string]int, len(r.Columns))
	for i, c := range r.Columns {
		cols[c] = i
	}
	out := make([]Row, len(r.Values))
	for i, v := range r.Values {
		out[i] = Row{cols: cols, vals: v}
	}
	return out
}

// Null reports a NULL or missing column.
func (r Row) Null(col string) bool {
	i, ok := r.cols[col]
	return !ok || r.vals[i] == nil
}

// Text is the column's text ("" for NULL).
func (r Row) Text(col string) string {
	i, ok := r.cols[col]
	if !ok || r.vals[i] == nil {
		return ""
	}
	return *r.vals[i]
}

// TextOrNil is the column's text or nil for NULL.
func (r Row) TextOrNil(col string) *string {
	i, ok := r.cols[col]
	if !ok || r.vals[i] == nil {
		return nil
	}
	v := *r.vals[i]
	return &v
}

// Bool reads t/f.
func (r Row) Bool(col string) bool { return r.Text(col) == "t" }

// Int reads an integer column (0 for NULL or garbage; callers that must
// tell these apart read Text).
func (r Row) Int(col string) int64 {
	n, _ := strconv.ParseInt(r.Text(col), 10, 64)
	return n
}

// Float reads a numeric column.
func (r Row) Float(col string) float64 {
	f, _ := strconv.ParseFloat(r.Text(col), 64)
	return f
}

func encodeArg(a any) (*string, error) {
	var s string
	switch v := a.(type) {
	case nil:
		return nil, nil
	case string:
		s = v
	case *string:
		if v == nil {
			return nil, nil
		}
		s = *v
	case bool:
		s = "f"
		if v {
			s = "t"
		}
	case int:
		s = strconv.Itoa(v)
	case int64:
		s = strconv.FormatInt(v, 10)
	default:
		return nil, fmt.Errorf("pgwire: unsupported argument type %T", a)
	}
	if strings.IndexByte(s, 0) >= 0 {
		return nil, errors.New("pgwire: an argument contains NUL")
	}
	return &s, nil
}

// Query runs one statement with bound arguments and returns its rows.
func (c *Conn) Query(ctx context.Context, sql string, args ...any) (*Rows, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.broken != nil {
		return nil, c.broken
	}
	if strings.IndexByte(sql, 0) >= 0 {
		return nil, errors.New("pgwire: the statement contains NUL")
	}
	stop := c.watch(ctx)
	defer stop()
	encoded := make([]*string, len(args))
	for i, a := range args {
		v, err := encodeArg(a)
		if err != nil {
			return nil, err
		}
		encoded[i] = v
	}
	var out []byte
	// Parse: unnamed statement, parameter types inferred.
	parse := append(append([]byte{0}, sql...), 0)
	parse = binary.BigEndian.AppendUint16(parse, 0)
	out = append(out, message('P', parse)...)
	// Bind: unnamed portal, all text.
	bind := []byte{0, 0}
	bind = binary.BigEndian.AppendUint16(bind, 0)
	bind = binary.BigEndian.AppendUint16(bind, uint16(len(encoded)))
	for _, v := range encoded {
		if v == nil {
			bind = binary.BigEndian.AppendUint32(bind, 0xFFFFFFFF)
			continue
		}
		bind = binary.BigEndian.AppendUint32(bind, uint32(len(*v)))
		bind = append(bind, *v...)
	}
	bind = binary.BigEndian.AppendUint16(bind, 0)
	out = append(out, message('B', bind)...)
	out = append(out, message('D', []byte{'P', 0})...)
	out = append(out, message('E', []byte{0, 0, 0, 0, 0})...)
	out = append(out, message('S', nil)...)
	if _, err := c.c.Write(out); err != nil {
		c.broken = err
		return nil, err
	}
	rows := &Rows{}
	var failure error
	for {
		t, data, err := c.read()
		if err != nil {
			c.broken = err
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, err
		}
		switch t {
		case '1', '2', 'n', 'I', 's', 'N':
		case 'S':
			k, v := cstrings2(data)
			c.params[k] = v
		case 'T':
			cols, err := rowDescription(data)
			if err != nil {
				c.broken = err
				return nil, err
			}
			rows.Columns = cols
		case 'D':
			vals, err := dataRow(data)
			if err != nil {
				c.broken = err
				return nil, err
			}
			rows.Values = append(rows.Values, vals)
		case 'C':
			rows.Command, _ = cstring(data)
		case 'E':
			failure = parseError(data)
		case 'Z':
			if len(data) > 0 {
				c.txStatus = data[0]
			}
			if failure != nil {
				return nil, failure
			}
			return rows, nil
		default:
			c.broken = fmt.Errorf("pgwire: unexpected message %q", t)
			return nil, c.broken
		}
	}
}

// Exec runs one statement and discards its rows.
func (c *Conn) Exec(ctx context.Context, sql string, args ...any) error {
	_, err := c.Query(ctx, sql, args...)
	return err
}

// InTransaction reports an open transaction block.
func (c *Conn) InTransaction() bool { return c.txStatus == 'T' || c.txStatus == 'E' }

func rowDescription(data []byte) ([]string, error) {
	if len(data) < 2 {
		return nil, errors.New("pgwire: short row description")
	}
	n := int(binary.BigEndian.Uint16(data))
	data = data[2:]
	cols := make([]string, 0, n)
	for i := 0; i < n; i++ {
		name, rest := cstring(data)
		if len(rest) < 18 {
			return nil, errors.New("pgwire: short field description")
		}
		cols = append(cols, name)
		data = rest[18:]
	}
	return cols, nil
}

func dataRow(data []byte) ([]*string, error) {
	if len(data) < 2 {
		return nil, errors.New("pgwire: short data row")
	}
	n := int(binary.BigEndian.Uint16(data))
	data = data[2:]
	vals := make([]*string, n)
	for i := 0; i < n; i++ {
		if len(data) < 4 {
			return nil, errors.New("pgwire: short value")
		}
		l := int32(binary.BigEndian.Uint32(data))
		data = data[4:]
		if l < 0 {
			continue
		}
		if int(l) > len(data) {
			return nil, errors.New("pgwire: value beyond the row")
		}
		v := string(data[:l])
		vals[i] = &v
		data = data[l:]
	}
	return vals, nil
}

// Close ends the session.
func (c *Conn) Close() error {
	var err error
	c.closeOnce.Do(func() {
		_ = c.c.SetDeadline(time.Now().Add(time.Second))
		_, _ = c.c.Write(message('X', nil))
		err = c.c.Close()
	})
	return err
}

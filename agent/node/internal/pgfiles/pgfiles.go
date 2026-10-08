// Package pgfiles renders and reads the PostgreSQL files ExponetDB manages
// on a host (capabilities.md §2): the configuration include fragment (OD-20)
// and the marked block in pg_hba.conf. The root helper writes them; the
// agent inspects them with the same code, so a plan and its apply agree on
// every byte.
package pgfiles

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
)

// Digest is the contract digest of file content.
func Digest(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// FragmentHeader opens every managed fragment.
const FragmentHeader = "# ExponetDB managed configuration (OD-20), written by exponetdb-node-helper.\n" +
	"# Do not edit: the next postgres.config.apply replaces this file.\n"

// Parameter is one line of the fragment.
type Parameter struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

var (
	parameterNameRE = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}(\.[a-z_][a-z0-9_]{0,62})?$`)
	managedNameRE   = regexp.MustCompile(`^[a-z_][a-z0-9_$-]{0,62}$`)
	addressRE       = regexp.MustCompile(`^(all|samehost|samenet|([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}|[0-9a-f:]{2,39}/[0-9]{1,3})$`)
)

// ErrInvalid: a value cannot be written into the file safely.
var ErrInvalid = errors.New("pgfiles: invalid value")

// Denied is the rule of the parameters ExponetDB never writes, in a
// fragment or as a role setting (Phase 4 review): file directives,
// parameters that run programs, load code or name paths, connection
// strings, and the socket and port the operator's mapping depends on. The
// contracts apply the same rule (DENIED_PARAMETERS); both are checked
// against tooling/fixtures/node-parameters/denied.json.
var Denied = struct {
	Names, Prefixes, Suffixes, Except []string
}{
	Names: []string{
		"include", "include_dir", "include_if_exists", "data_directory", "config_file", "hba_file",
		"ident_file", "external_pid_file", "event_source", "log_filename", "port",
		"allow_system_table_mods", "session_replication_role",
	},
	Prefixes: []string{"unix_socket_", "plperl.", "pltcl.", "pltclu.", "plpython"},
	Suffixes: []string{
		"_command", "_file", "_files", "_directory", "_directories", "_dir", "_library",
		"_libraries", "_path", "_conninfo", "_keyfile", "_provider",
	},
	Except: []string{"search_path"},
}

// ManagedParameter reports whether ExponetDB may write the parameter: the
// contract's name pattern and the Denied rule.
func ManagedParameter(name string) bool {
	if !parameterNameRE.MatchString(name) {
		return false
	}
	for _, e := range Denied.Except {
		if name == e {
			return true
		}
	}
	for _, n := range Denied.Names {
		if name == n {
			return false
		}
	}
	for _, p := range Denied.Prefixes {
		if strings.HasPrefix(name, p) {
			return false
		}
	}
	for _, x := range Denied.Suffixes {
		if strings.HasSuffix(name, x) {
			return false
		}
	}
	return true
}

// RenderFragment renders the complete fragment: each value single-quoted,
// with a quote doubled and a backslash escaped, as postgresql.conf reads it.
// A name twice, a name ExponetDB never writes (a directive such as
// include_dir, a command, library, path or socket), a value outside the
// contract pattern or a control character is refused.
func RenderFragment(params []Parameter) ([]byte, error) {
	var b strings.Builder
	b.WriteString(FragmentHeader)
	seen := map[string]bool{}
	for _, p := range params {
		if !ManagedParameter(p.Name) || seen[p.Name] || len(p.Value) > 1024 {
			return nil, fmt.Errorf("%w: parameter %q", ErrInvalid, p.Name)
		}
		seen[p.Name] = true
		for _, r := range p.Value {
			if r < 0x20 || r == 0x7f {
				return nil, fmt.Errorf("%w: parameter %s has a control character", ErrInvalid, p.Name)
			}
		}
		value := strings.ReplaceAll(p.Value, `\`, `\\`)
		value = strings.ReplaceAll(value, `'`, `''`)
		b.WriteString(p.Name + " = '" + value + "'\n")
	}
	return []byte(b.String()), nil
}

// ErrForeign: a managed fragment holds a line ExponetDB did not write (an
// edit on the host). A patch never guesses around it.
var ErrForeign = errors.New("pgfiles: the managed fragment holds a line ExponetDB did not write")

// ParseFragment reads a managed fragment exactly as RenderFragment wrote it:
// the header, then one `name = 'value'` line per parameter. Anything else (a
// comment, a directive, another quoting) is ErrForeign. Empty data is an
// empty fragment.
func ParseFragment(data []byte) ([]Parameter, error) {
	if len(data) == 0 {
		return nil, nil
	}
	body, ok := strings.CutPrefix(string(data), FragmentHeader)
	if !ok {
		return nil, ErrForeign
	}
	var out []Parameter
	for body != "" {
		line, rest, found := strings.Cut(body, "\n")
		if !found {
			return nil, ErrForeign
		}
		body = rest
		name, quoted, ok := strings.Cut(line, " = '")
		if !ok || !strings.HasSuffix(quoted, "'") {
			return nil, ErrForeign
		}
		raw := strings.TrimSuffix(quoted, "'")
		var b strings.Builder
		for i := 0; i < len(raw); i++ {
			switch {
			case raw[i] == '\\' && i+1 < len(raw) && raw[i+1] == '\\',
				raw[i] == '\'' && i+1 < len(raw) && raw[i+1] == '\'':
				b.WriteByte(raw[i])
				i++
			case raw[i] == '\\', raw[i] == '\'':
				return nil, ErrForeign
			default:
				b.WriteByte(raw[i])
			}
		}
		out = append(out, Parameter{Name: name, Value: b.String()})
	}
	// What was read must be what RenderFragment writes for it, byte for byte.
	again, err := RenderFragment(out)
	if err != nil || string(again) != string(data) {
		return nil, ErrForeign
	}
	return out, nil
}

// Change sets a parameter of the fragment, or removes it (Value nil).
type Change struct {
	Name  string  `json:"name"`
	Value *string `json:"value"`
}

// PatchFragment applies changes to a managed fragment in order: a set
// replaces the parameter's line in place or adds it at the end, a removal
// drops it. Every other line stays exactly as it was. current nil is no
// fragment.
func PatchFragment(current []byte, changes []Change) ([]byte, error) {
	params, err := ParseFragment(current)
	if err != nil {
		return nil, err
	}
	for _, c := range changes {
		at := -1
		for i, p := range params {
			if p.Name == c.Name {
				at = i
			}
		}
		switch {
		case c.Value == nil && at >= 0:
			params = append(params[:at], params[at+1:]...)
		case c.Value != nil && at >= 0:
			params[at].Value = *c.Value
		case c.Value != nil:
			params = append(params, Parameter{Name: c.Name, Value: *c.Value})
		}
	}
	return RenderFragment(params)
}

// The managed block markers in pg_hba.conf.
const (
	BeginMarker = "# BEGIN EXPONETDB MANAGED BLOCK"
	EndMarker   = "# END EXPONETDB MANAGED BLOCK"
)

// HbaRule is one managed rule (contracts NodeCapHbaApplyArgs).
type HbaRule struct {
	Type     string   `json:"type"`
	Database []string `json:"database"`
	User     []string `json:"user"`
	Address  *string  `json:"address"`
	Method   string   `json:"method"`
	Map      *string  `json:"map"`
}

// names renders database or role names: every name but the keyword all is
// double-quoted, so a role or database called replication, sameuser,
// samerole or samegroup is never read as a keyword (Phase 4 review).
func names(list []string) (string, error) {
	if len(list) == 0 || len(list) > 16 {
		return "", ErrInvalid
	}
	out := make([]string, 0, len(list))
	for _, n := range list {
		if !managedNameRE.MatchString(n) {
			return "", fmt.Errorf("%w: name %q", ErrInvalid, n)
		}
		if n == "all" {
			out = append(out, n)
			continue
		}
		out = append(out, `"`+n+`"`)
	}
	return strings.Join(out, ","), nil
}

// validAddress: the keywords all, samehost, samenet, or a CIDR address that
// parses (no 999.1.1.1/40).
func validAddress(a string) bool {
	switch a {
	case "all", "samehost", "samenet":
		return true
	}
	if !addressRE.MatchString(a) {
		return false
	}
	_, _, err := net.ParseCIDR(a)
	return err == nil
}

func (r HbaRule) line() (string, error) {
	db, err := names(r.Database)
	if err != nil {
		return "", err
	}
	user, err := names(r.User)
	if err != nil {
		return "", err
	}
	switch r.Method {
	case "scram-sha-256", "peer", "reject":
	default:
		return "", fmt.Errorf("%w: method", ErrInvalid)
	}
	if r.Map != nil && (r.Method != "peer" || !managedNameRE.MatchString(*r.Map)) {
		return "", fmt.Errorf("%w: map", ErrInvalid)
	}
	switch {
	case r.Type == "local" && r.Address == nil:
		line := "local " + db + " " + user + " " + r.Method
		if r.Map != nil {
			line += " map=" + *r.Map
		}
		return line, nil
	case r.Type == "hostssl" && r.Address != nil && validAddress(*r.Address) && r.Method != "peer":
		return "hostssl " + db + " " + user + " " + *r.Address + " " + r.Method, nil
	}
	return "", fmt.Errorf("%w: rule type, address or method", ErrInvalid)
}

// RenderHbaBlock renders the managed block, markers included.
func RenderHbaBlock(rules []HbaRule) ([]byte, error) {
	if len(rules) > 64 {
		return nil, ErrInvalid
	}
	var b strings.Builder
	b.WriteString(BeginMarker + ": written by exponetdb-node-helper, do not edit\n")
	for _, r := range rules {
		line, err := r.line()
		if err != nil {
			return nil, err
		}
		b.WriteString(line + "\n")
	}
	b.WriteString(EndMarker + "\n")
	return []byte(b.String()), nil
}

// Block locates the managed block of a pg_hba file.
type Block struct {
	Present bool
	// Start and End are byte offsets: the block is file[Start:End], its
	// marker lines included.
	Start, End int
	// Lines counts the rule lines between the markers.
	Lines int
}

// ErrMarkers: the markers are not exactly one BEGIN followed by one END.
var ErrMarkers = errors.New("pgfiles: the managed block markers are ambiguous")

func isMarker(line, marker string) bool {
	line = strings.TrimRight(line, " \t\r\n")
	return line == marker || strings.HasPrefix(line, marker+":") || strings.HasPrefix(line, marker+" ")
}

// FindBlock finds the managed block; a file with no marker has none.
func FindBlock(file []byte) (Block, error) {
	var b Block
	begin, end, offset := -1, -1, 0
	lines := strings.SplitAfter(string(file), "\n")
	beginLine, endLine := 0, 0
	for i, line := range lines {
		switch {
		case isMarker(line, BeginMarker):
			if begin != -1 {
				return Block{}, ErrMarkers
			}
			begin, beginLine = offset, i
		case isMarker(line, EndMarker):
			if begin == -1 || end != -1 {
				return Block{}, ErrMarkers
			}
			end, endLine = offset+len(line), i
		}
		offset += len(line)
	}
	if begin == -1 && end == -1 {
		return b, nil
	}
	if begin == -1 || end == -1 {
		return Block{}, ErrMarkers
	}
	return Block{Present: true, Start: begin, End: end, Lines: endLine - beginLine - 1}, nil
}

// SpliceHba returns the file with its managed block replaced by block, or
// with block inserted at the top when the file has none: managed rules come
// first, so no foreign rule shadows them. Foreign lines are kept byte for
// byte.
func SpliceHba(file, block []byte) ([]byte, error) {
	b, err := FindBlock(file)
	if err != nil {
		return nil, err
	}
	if !b.Present {
		return append(append([]byte{}, block...), file...), nil
	}
	out := append([]byte{}, file[:b.Start]...)
	out = append(out, block...)
	return append(out, file[b.End:]...), nil
}

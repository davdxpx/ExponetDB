package capabilities

import (
	"context"
	"encoding/hex"
	"errors"
	"math"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgfiles"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgwire"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// The server's configuration as ExponetDB plans against it (OD-20): the
// settings and file settings, never a session's own values, and the
// managed include fragment.

type setting struct {
	name, vartype, context, unit, source string
	setting, sourcefile, minVal, maxVal  *string
	enumvals                             []string
	sourceline                           *int64
	pending                              bool
}

// readFile reads a server-side file as the superuser can (nil when absent).
func readFile(ctx context.Context, c *pgwire.Conn, path string) ([]byte, bool, error) {
	rows, err := c.Query(ctx, `SELECT CASE WHEN (pg_catalog.pg_stat_file($1, true)).size IS NULL THEN NULL
		ELSE pg_catalog.pg_read_binary_file($1) END AS content`, path)
	if err != nil {
		return nil, false, err
	}
	r := rows.Each()[0]
	if r.Null("content") {
		return nil, false, nil
	}
	data, err := hex.DecodeString(strings.TrimPrefix(r.Text("content"), `\x`))
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

var (
	includeDirRE  = regexp.MustCompile(`^\s*include_dir\s*=?\s*'((?:[^']|'')*)'`)
	includeFileRE = regexp.MustCompile(`^\s*include(?:_if_exists)?\s*=?\s*'((?:[^']|'')*)'`)
)

// included reports whether postgresql.conf itself includes the fragment: an
// include_dir of its directory (the fragment ends in .conf and does not
// start with a dot) or an include of its path (OD-20 bootstrap need).
func included(conf []byte, configFile, fragment string) bool {
	base := filepath.Dir(configFile)
	resolve := func(p string) string {
		p = strings.ReplaceAll(p, "''", "'")
		if !filepath.IsAbs(p) {
			p = filepath.Join(base, p)
		}
		return filepath.Clean(p)
	}
	name := filepath.Base(fragment)
	for _, line := range strings.Split(string(conf), "\n") {
		if m := includeDirRE.FindStringSubmatch(line); m != nil {
			if resolve(m[1]) == filepath.Dir(fragment) && strings.HasSuffix(name, ".conf") && !strings.HasPrefix(name, ".") {
				return true
			}
			continue
		}
		if m := includeFileRE.FindStringSubmatch(line); m != nil && resolve(m[1]) == fragment {
			return true
		}
	}
	return false
}

type inspection struct {
	settings     []setting
	settingsJSON canon.Array
	fileJSON     canon.Array
	fileRows     []pgwire.Row
	include      canon.Object
	present      bool
	isIncluded   bool
	version      string
}

func inspectConfig(ctx context.Context, c *pgwire.Conn, in config.Instance) (*inspection, error) {
	out := &inspection{settingsJSON: canon.Array{}, fileJSON: canon.Array{}}
	files, err := c.Query(ctx, `SELECT sourcefile, sourceline, seqno, name, setting, applied, error
		FROM pg_catalog.pg_file_settings ORDER BY seqno LIMIT 4096`)
	if err != nil {
		return nil, err
	}
	out.fileRows = files.Each()
	applied := map[string]pgwire.Row{}
	for _, r := range out.fileRows {
		if r.Bool("applied") {
			applied[r.Text("name")] = r
		}
	}
	rows, err := c.Query(ctx, `SELECT name, setting, unit, source, sourcefile, sourceline, context, vartype,
		pending_restart, min_val, max_val, boot_val, array_to_string(enumvals, chr(31)) AS enumvals
		FROM pg_catalog.pg_settings ORDER BY name LIMIT 2048`)
	if err != nil {
		return nil, err
	}
	for _, r := range rows.Each() {
		s := setting{name: r.Text("name"), vartype: r.Text("vartype"), context: r.Text("context"), unit: r.Text("unit"),
			source: r.Text("source"), setting: r.TextOrNil("setting"), sourcefile: r.TextOrNil("sourcefile"),
			minVal: r.TextOrNil("min_val"), maxVal: r.TextOrNil("max_val"), pending: r.Bool("pending_restart")}
		if !r.Null("sourceline") {
			n := r.Int("sourceline")
			s.sourceline = &n
		}
		// A value this session set (the agent's own startup options) is not
		// the server's: the server's is what the files apply, or the default.
		if s.source == "client" || s.source == "session" {
			if f, ok := applied[s.name]; ok {
				v, file, line := f.Text("setting"), f.Text("sourcefile"), f.Int("sourceline")
				s.setting, s.source, s.sourcefile, s.sourceline = &v, "configuration file", &file, &line
			} else {
				s.setting, s.source, s.sourcefile, s.sourceline = r.TextOrNil("boot_val"), "default", nil, nil
			}
		}
		if e := r.Text("enumvals"); e != "" {
			s.enumvals = strings.Split(e, "\x1f")
		}
		out.settings = append(out.settings, s)
		var unit, val, file, line any
		if s.unit != "" {
			unit = bound(s.unit, 16)
		}
		if s.setting != nil {
			val = bound(*s.setting, 4096)
		}
		if s.sourcefile != nil {
			file = bound(*s.sourcefile, 4096)
		}
		if s.sourceline != nil {
			line = *s.sourceline
		}
		out.settingsJSON = append(out.settingsJSON, obj("name", bound(s.name, 256), "setting", val, "unit", unit,
			"source", bound(s.source, 64), "sourcefile", file, "sourceline", line, "context", bound(s.context, 32),
			"vartype", bound(s.vartype, 16), "pendingRestart", s.pending))
	}
	for _, r := range out.fileRows {
		nullable := func(col string, n int) any {
			if v := r.TextOrNil(col); v != nil {
				return bound(*v, n)
			}
			return nil
		}
		intOrNil := func(col string) any {
			if r.Null(col) {
				return nil
			}
			return r.Int(col)
		}
		out.fileJSON = append(out.fileJSON, obj("sourcefile", nullable("sourcefile", 4096), "sourceline", intOrNil("sourceline"),
			"seqno", intOrNil("seqno"), "name", nullable("name", 256), "setting", nullable("setting", 4096),
			"applied", r.Bool("applied"), "error", nullable("error", 1024)))
	}
	fragment, present, err := readFile(ctx, c, in.ManagedInclude)
	if err != nil {
		return nil, err
	}
	conf, _, err := readFile(ctx, c, in.ConfigFile)
	if err != nil {
		return nil, err
	}
	out.present, out.isIncluded = present, included(conf, in.ConfigFile, in.ManagedInclude)
	var fragmentDigest any
	if present {
		fragmentDigest = pgfiles.Digest(fragment)
	}
	out.include = obj("path", in.ManagedInclude, "present", present, "included", out.isIncluded, "digest", fragmentDigest)
	out.version, err = digest(obj("settings", out.settingsJSON, "fileSettings", out.fileJSON))
	return out, err
}

// ----- postgres.config.inspect@1 -----

type configInspect struct{ clusterBound }

func (p configInspect) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	in, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	i, err := inspectConfig(ctx, c, in)
	if err != nil {
		return nil, err
	}
	if err := step(run, "inspect"); err != nil {
		return nil, err
	}
	return obj("configVersion", i.version, "settings", i.settingsJSON, "fileSettings", i.fileJSON, "managedInclude", i.include), nil
}

// ----- postgres.config.plan@1 -----

type configPlan struct{ clusterBound }

func (p configPlan) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	in, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	i, err := inspectConfig(ctx, c, in)
	if err != nil {
		return nil, err
	}
	byName := map[string]setting{}
	for _, s := range i.settings {
		byName[s.name] = s
	}
	params := canon.Array{}
	for _, item := range list(job.Args, "changes") {
		change, _ := item.(canon.Object)
		name := text(change, "name")
		value := textOrNil(change, "value")
		s, known := byName[name]
		valid, reason := true, any(nil)
		var current, source, file, contextName any
		effect := "reload"
		switch {
		case !known && !strings.Contains(name, "."):
			valid, reason, effect = false, "unknown_parameter", "none"
		case known:
			if s.setting != nil {
				current = bound(*s.setting, 4096)
			}
			source, contextName = bound(s.source, 64), bound(s.context, 32)
			if s.sourcefile != nil {
				file = bound(*s.sourcefile, 4096)
			}
			switch s.context {
			case "internal":
				valid, reason, effect = false, "not_settable_in_file", "none"
			case "postmaster":
				effect = "restart"
			}
			if valid && value != nil {
				if r := checkValue(s, *value); r != "" {
					valid, reason = false, r
				}
			}
		}
		if valid && value != nil && current == *value && effect != "none" {
			effect = "none"
		}
		params = append(params, obj("name", name, "valid", valid, "invalidReason", reason, "current", current,
			"currentSource", source, "currentSourcefile", file, "context", contextName, "effect", effect,
			"conflict", conflictOf(i.fileRows, name, in.ManagedInclude)))
	}
	if err := step(run, "plan"); err != nil {
		return nil, err
	}
	return obj("configVersion", i.version, "managedInclude", i.include, "parameters", params), nil
}

// conflictOf: a value read after the managed fragment would win over it.
func conflictOf(rows []pgwire.Row, name, fragment string) any {
	lastFragment := int64(-1)
	for _, r := range rows {
		if r.Text("sourcefile") == fragment && r.Int("seqno") > lastFragment {
			lastFragment = r.Int("seqno")
		}
	}
	later := false
	for _, r := range rows {
		if r.Text("name") != name || r.Text("sourcefile") == fragment {
			continue
		}
		file := r.Text("sourcefile")
		if strings.HasSuffix(file, "/postgresql.auto.conf") {
			return "auto_conf_overrides"
		}
		switch {
		case lastFragment >= 0 && r.Int("seqno") > lastFragment:
			later = true
		case lastFragment < 0 && filepath.Dir(file) == filepath.Dir(fragment) && filepath.Base(file) > filepath.Base(fragment):
			later = true
		}
	}
	if later {
		return "later_file_overrides"
	}
	return nil
}

var (
	unitRE  = regexp.MustCompile(`^([0-9]*)(B|kB|MB|GB|TB|us|ms|s|min|h|d)$`)
	valueRE = regexp.MustCompile(`^\s*([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*([A-Za-z]*)\s*$`)
	memory  = map[string]float64{"B": 1, "kB": 1 << 10, "MB": 1 << 20, "GB": 1 << 30, "TB": 1 << 40}
	times   = map[string]float64{"us": 1, "ms": 1e3, "s": 1e6, "min": 60e6, "h": 3600e6, "d": 86400e6}
)

// checkValue validates a value as PostgreSQL would read it from a file, by
// the parameter's type, unit, range and enumeration ("" when valid).
func checkValue(s setting, value string) string {
	switch s.vartype {
	case "bool":
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "on", "off", "true", "false", "yes", "no", "1", "0", "t", "f", "y", "n":
			return ""
		}
		return "invalid_value"
	case "enum":
		for _, e := range s.enumvals {
			if strings.EqualFold(e, strings.TrimSpace(value)) {
				return ""
			}
		}
		return "invalid_value"
	case "integer", "real":
		n, ok := numeric(s.unit, value)
		if !ok {
			return "invalid_value"
		}
		if s.vartype == "integer" {
			n = math.Round(n)
		}
		if s.minVal != nil {
			if lo, err := strconv.ParseFloat(*s.minVal, 64); err == nil && n < lo {
				return "out_of_range"
			}
		}
		if s.maxVal != nil {
			if hi, err := strconv.ParseFloat(*s.maxVal, 64); err == nil && n > hi {
				return "out_of_range"
			}
		}
		return ""
	}
	return ""
}

// numeric converts a value with an optional unit into the parameter's base
// unit (pg_settings.unit, such as 8kB or ms).
func numeric(baseUnit, value string) (float64, bool) {
	m := valueRE.FindStringSubmatch(value)
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	given := m[2]
	if given == "" {
		return n, true
	}
	b := unitRE.FindStringSubmatch(baseUnit)
	if b == nil {
		return 0, false
	}
	scale := 1.0
	if b[1] != "" {
		scale, _ = strconv.ParseFloat(b[1], 64)
	}
	if f, ok := memory[b[2]]; ok {
		g, ok := memory[given]
		if !ok {
			return 0, false
		}
		return n * g / (f * scale), true
	}
	f := times[b[2]]
	g, ok := times[given]
	if !ok {
		return 0, false
	}
	return n * g / (f * scale), true
}

// ----- postgres.config.apply@1 -----

type configApply struct{ clusterBound }

func (p configApply) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	in, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	i, err := inspectConfig(ctx, c, in)
	if err != nil {
		return nil, err
	}
	if i.version != text(job.Args, "configVersion") {
		return nil, preconditionf("the configuration changed since the plan")
	}
	if !i.isIncluded {
		return nil, preconditionf("postgresql.conf does not include the managed fragment (OD-20 bootstrap)")
	}
	if err := step(run, "check"); err != nil {
		return nil, err
	}
	if err := run.BeginEffect(); err != nil {
		return nil, err
	}
	written, err := p.env.Helper.Call(ctx, helperproto.OpConfigWriteFragment, job.Envelope)
	if err != nil {
		return nil, err
	}
	if err := step(run, "write_fragment"); err != nil {
		return nil, err
	}
	reloaded := false
	if boolOf(job.Args, "reload") {
		if err := reload(ctx, c); err != nil {
			return nil, err
		}
		reloaded = true
		if err := step(run, "reload"); err != nil {
			return nil, err
		}
	}
	pending, err := pendingRestart(ctx, c)
	if err != nil {
		return nil, err
	}
	errs, err := fileErrors(ctx, c)
	if err != nil {
		return nil, err
	}
	if text(written, "fragmentDigest") == "" {
		return nil, errors.New("the helper reported no fragment digest")
	}
	return obj("fragmentDigest", text(written, "fragmentDigest"), "previousFragmentDigest", member(written, "previousFragmentDigest"),
		"reloaded", reloaded, "pendingRestart", pending, "fileErrors", errs), nil
}

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

// loadedFrom is where pg_settings says a running value comes from, before
// the agent's own session values are replaced by the files' (known false:
// the agent's session sets the parameter itself, so its source proves
// nothing of the server's).
type loadedFrom struct {
	file    string
	line    int64
	known   bool
	pending bool
}

type inspection struct {
	loaded       map[string]loadedFrom
	pendingNow   map[string]bool
	settings     []setting
	types        map[string]paramType
	settingsJSON canon.Array
	fileJSON     canon.Array
	fileRows     []pgwire.Row
	include      canon.Object
	present      bool
	isIncluded   bool
	version      string
}

// fileDigests asks the root helper for the keyed digests of the managed
// fragment and pg_hba.conf, under the read job's authority: the digests a
// plan binds and the helper's own writes check (capabilities.md §6).
func (e *Env) fileDigests(ctx context.Context, job *verify.Job) (fragmentPresent bool, fragment canon.Value, hba string, err error) {
	if e.Helper == nil {
		return false, nil, "", errors.New("the root helper is not configured")
	}
	r, err := e.Helper.Call(ctx, helperproto.OpFilesDigest, job.Envelope)
	if err != nil {
		return false, nil, "", err
	}
	f, _ := member(r, "fragment").(canon.Object)
	fragment = member(f, "digest")
	if fragment == nil {
		fragment = canon.Null{}
	}
	if _, isNull := fragment.(canon.Null); !isNull {
		if s, ok := fragment.(canon.String); !ok || !strings.HasPrefix(string(s), "kd1:") {
			return false, nil, "", errors.New("the helper reported no keyed fragment digest")
		}
	}
	hba = text(r, "hbaFile")
	if !strings.HasPrefix(hba, "kd1:") {
		return false, nil, "", errors.New("the helper reported no keyed pg_hba digest")
	}
	return boolOf(f, "present"), fragment, hba, nil
}

// inspectConfig reads the server's configuration: the settings and file
// settings as PostgreSQL has them (raw, for the keyed configVersion and the
// node's own checks) and as the node exports them (by export class).
func (e *Env) inspectConfig(ctx context.Context, c *pgwire.Conn, in config.Instance, job *verify.Job, withDigests bool) (*inspection, error) {
	out := &inspection{settingsJSON: canon.Array{}, fileJSON: canon.Array{}, loaded: map[string]loadedFrom{}}
	types, err := paramTypes(ctx, c)
	if err != nil {
		return nil, err
	}
	out.types = types
	// pg_settings first: reading pg_file_settings re-reads the files in this
	// session and marks pending_restart in it, which would make a change the
	// server has not reloaded look pending (correction review, round 4).
	rows, err := c.Query(ctx, `SELECT name, setting, unit, source, sourcefile, sourceline, context, vartype,
		pending_restart, min_val, max_val, boot_val, array_to_string(enumvals, chr(31)) AS enumvals
		FROM pg_catalog.pg_settings ORDER BY name LIMIT 2048`)
	if err != nil {
		return nil, err
	}
	files, err := c.Query(ctx, `SELECT sourcefile, sourceline, seqno, name, setting, applied, error
		FROM pg_catalog.pg_file_settings ORDER BY seqno LIMIT 4096`)
	if err != nil {
		return nil, err
	}
	out.fileRows = files.Each()
	// Reading pg_file_settings evaluated the files in this session: a line
	// whose valid value waits for a restart is now pending here, also when
	// the server has not reloaded (correction review, round 5).
	pendingNow, err := c.Query(ctx, `SELECT name FROM pg_catalog.pg_settings WHERE pending_restart`)
	if err != nil {
		return nil, err
	}
	out.pendingNow = map[string]bool{}
	for _, r := range pendingNow.Each() {
		out.pendingNow[strings.ToLower(r.Text("name"))] = true
	}
	applied := map[string]pgwire.Row{}
	for _, r := range out.fileRows {
		if r.Bool("applied") {
			applied[r.Text("name")] = r
		}
	}
	// The digest input holds every value as read, withheld ones included: a
	// change of a withheld value changes configVersion (drift and CAS), and
	// the digest is keyed, so it confirms no guess of a value.
	rawSettings, rawFiles := canon.Array{}, canon.Array{}
	for _, r := range rows.Each() {
		s := setting{name: r.Text("name"), vartype: r.Text("vartype"), context: r.Text("context"), unit: r.Text("unit"),
			source: r.Text("source"), setting: r.TextOrNil("setting"), sourcefile: r.TextOrNil("sourcefile"),
			minVal: r.TextOrNil("min_val"), maxVal: r.TextOrNil("max_val"), pending: r.Bool("pending_restart")}
		if !r.Null("sourceline") {
			n := r.Int("sourceline")
			s.sourceline = &n
		}
		// Only a value from a configuration file (or the default) is the
		// server's own in this session; a role, database, client or session
		// value hides it (correction review, round 5).
		out.loaded[strings.ToLower(s.name)] = loadedFrom{file: r.Text("sourcefile"), line: r.Int("sourceline"),
			known: s.source == "configuration file" || s.source == "default", pending: s.pending}
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
		var unit, file, line any
		if s.unit != "" {
			unit = bound(s.unit, 16)
		}
		if s.sourcefile != nil {
			file = bound(*s.sourcefile, 4096)
		}
		if s.sourceline != nil {
			line = *s.sourceline
		}
		t := types[strings.ToLower(s.name)]
		row := func(value any) canon.Object {
			return obj("name", bound(s.name, 256), "setting", value, "unit", unit,
				"source", bound(s.source, 64), "sourcefile", file, "sourceline", line, "context", bound(s.context, 32),
				"vartype", bound(s.vartype, 16), "pendingRestart", s.pending)
		}
		rawSettings = append(rawSettings, row(s.setting))
		out.settingsJSON = append(out.settingsJSON, row(shownNullable(s.name, t, true, s.setting)))
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
		name := r.TextOrNil("name")
		var shown canon.Value = canon.Null{}
		if raw := r.TextOrNil("setting"); raw != nil {
			if name == nil {
				shown = withheld(withheldUnclassified)
			} else {
				t, known := types[strings.ToLower(*name)]
				shown = exportValue(*name, t, known, *raw)
			}
		}
		rawFiles = append(rawFiles, obj("sourcefile", r.TextOrNil("sourcefile"), "sourceline", intOrNil("sourceline"),
			"seqno", intOrNil("seqno"), "name", name, "setting", r.TextOrNil("setting"),
			"applied", r.Bool("applied"), "error", r.TextOrNil("error")))
		out.fileJSON = append(out.fileJSON, obj("sourcefile", nullable("sourcefile", 4096), "sourceline", intOrNil("sourceline"),
			"seqno", intOrNil("seqno"), "name", nullable("name", 256), "setting", shown,
			"applied", r.Bool("applied"), "error", shownError(fixedFileErrors, r.TextOrNil("error"))))
	}
	// The fragment's keyed digest comes from the root helper for a read
	// (config.inspect, config.plan); an apply's helper call checks the one its
	// plan bound itself.
	present, fragmentDigest := false, canon.Value(canon.Null{})
	if withDigests {
		present, fragmentDigest, _, err = e.fileDigests(ctx, job)
		if err != nil {
			return nil, err
		}
	}
	conf, _, err := readFile(ctx, c, in.ConfigFile)
	if err != nil {
		return nil, err
	}
	out.present, out.isIncluded = present, included(conf, in.ConfigFile, in.ManagedInclude)
	out.include = obj("path", in.ManagedInclude, "present", present, "included", out.isIncluded, "digest", fragmentDigest)
	out.version, err = e.keyed(purposeConfigVersion, obj("settings", rawSettings, "fileSettings", rawFiles))
	return out, err
}

// ----- postgres.config.inspect@2 -----

type configInspect struct{ clusterBound }

func (p configInspect) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	in, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	i, err := p.env.inspectConfig(ctx, c, in, job, true)
	if err != nil {
		return nil, err
	}
	if err := step(run, "inspect"); err != nil {
		return nil, err
	}
	return obj("configVersion", i.version, "settings", i.settingsJSON, "fileSettings", i.fileJSON, "managedInclude", i.include), nil
}

// ----- postgres.config.plan@2 -----

type configPlan struct{ clusterBound }

// pendingRestartError is the error PostgreSQL reports for a file line of a
// parameter that changes only at a restart.
const pendingRestartError = "setting could not be applied"

// managedLine is the managed fragment's last line for a parameter, compared
// on the host with the requested value: the value itself never leaves. A
// value its export class withholds is never compared ("held"): the right
// guess and a wrong one read the same (correction review, round 2).
// pg_file_settings reads the files as they are now, so its applied column
// proves no reload: loaded says whether pg_settings names this very line as
// the source of the running value, and a line that only waits for a
// restart is pendingRestart, not an error (correction review, round 4).
func managedLine(rows []pgwire.Row, fragment, name string, requested *string, types map[string]paramType, src loadedFrom, srcFound, pendingNow bool) canon.Object {
	var last *pgwire.Row
	for i := range rows {
		if rows[i].Text("sourcefile") == fragment && strings.EqualFold(rows[i].Text("name"), name) {
			last = &rows[i]
		}
	}
	if last == nil {
		return obj("state", "absent", "applied", nil, "error", false, "loaded", nil, "pendingRestart", false)
	}
	state := "other"
	t, known := types[strings.ToLower(name)]
	if _, shown := exportValue(name, t, known, last.Text("setting")).(canon.String); !shown {
		state = "held"
	} else if requested != nil && last.Text("setting") == *requested {
		state = "requested"
	}
	var loaded any
	if srcFound && src.known {
		loaded = src.file == fragment && src.line == last.Int("sourceline")
	}
	pendingRestart := !last.Null("error") && last.Text("error") == pendingRestartError && (srcFound && src.pending || pendingNow)
	return obj("state", state, "applied", last.Bool("applied"), "error", !last.Null("error") && !pendingRestart,
		"loaded", loaded, "pendingRestart", pendingRestart)
}

func (p configPlan) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	in, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	i, err := p.env.inspectConfig(ctx, c, in, job, true)
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
		var source, file, contextName any
		var current canon.Value = canon.Null{}
		effect := "reload"
		switch {
		case !known && !strings.Contains(name, "."):
			valid, reason, effect = false, "unknown_parameter", "none"
		case known:
			current = shownNullable(s.name, i.types[strings.ToLower(s.name)], true, s.setting)
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
		// Only a shown value is compared: a withheld one is never tested
		// against a requested value (capabilities.md §6).
		if shown, ok := current.(canon.String); ok && valid && value != nil && string(shown) == *value && effect != "none" {
			effect = "none"
		}
		params = append(params, obj("name", name, "valid", valid, "invalidReason", reason, "current", current,
			"currentSource", source, "currentSourcefile", file, "context", contextName, "effect", effect,
			"conflict", conflictOf(i.fileRows, name, in.ManagedInclude),
			"managed", managedLine(i.fileRows, in.ManagedInclude, name, value, i.types, i.loaded[strings.ToLower(name)], hasLoaded(i.loaded, name),
				i.pendingNow[strings.ToLower(name)])))
	}
	if err := step(run, "plan"); err != nil {
		return nil, err
	}
	return obj("configVersion", i.version, "managedInclude", i.include, "parameters", params), nil
}

func hasLoaded(m map[string]loadedFrom, name string) bool {
	_, ok := m[strings.ToLower(name)]
	return ok
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

// ----- postgres.config.apply@2 -----

type configApply struct{ clusterBound }

// Run checks the keyed configVersion, then has the root helper patch the
// managed fragment with the plan's changes only (every other line stays on
// the host as it is), reloads when asked and reports what PostgreSQL loaded.
func (p configApply) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	in, c, err := p.env.session(ctx, job.Args, "")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	i, err := p.env.inspectConfig(ctx, c, in, job, false)
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
	written, err := p.env.Helper.Call(ctx, helperproto.OpConfigPatchFragment, job.Envelope)
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
	if !strings.HasPrefix(text(written, "fragmentDigest"), "kd1:") {
		return nil, errors.New("the helper reported no fragment digest")
	}
	return obj("fragmentDigest", text(written, "fragmentDigest"), "previousFragmentDigest", member(written, "previousFragmentDigest"),
		"reloaded", reloaded, "pendingRestart", pending, "fileErrors", errs), nil
}

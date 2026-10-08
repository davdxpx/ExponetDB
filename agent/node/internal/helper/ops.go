package helper

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsafe"
	"github.com/davdxpx/ExponetDB/agent/node/internal/kdigest"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgfiles"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

type clusterRef struct {
	LocalName        string `json:"localName"`
	SystemIdentifier string `json:"systemIdentifier"`
}

// maxFile bounds a file the helper reads (pg_hba.conf, a fragment, a
// certificate).
const maxFile = 1 << 20

var unitRE = regexp.MustCompile(`^postgresql@[0-9]{2}-[a-z0-9_-]{1,63}\.service$`)

// instance resolves the job's cluster to the operator's mapping and checks
// the system identifier itself, from the data directory's pg_control: the
// helper acts on the instance the job names or not at all.
func (h *Helper) instance(ref clusterRef) (config.Instance, *Refusal) {
	in, ok := h.Config.Instance(ref.LocalName)
	if !ok {
		return config.Instance{}, refuse(CodeNotConfigured, "the operator did not map cluster %s", ref.LocalName)
	}
	if !unitRE.MatchString(in.Unit) {
		return config.Instance{}, refuse(CodeNotConfigured, "the unit of cluster %s is not a postgresql@ unit", ref.LocalName)
	}
	id, err := h.systemIdentifier(in.DataDirectory)
	if err != nil {
		return config.Instance{}, refuse(CodeFailed, "the control file of cluster %s cannot be read", ref.LocalName)
	}
	if id != ref.SystemIdentifier {
		return config.Instance{}, refuse(CodePreconditionFailed, "cluster %s has another system identifier", ref.LocalName)
	}
	return in, nil
}

// systemIdentifier reads ControlFileData.system_identifier, the first
// member of global/pg_control (native byte order).
func (h *Helper) systemIdentifier(dataDirectory string) (string, error) {
	dir, err := fsafe.OpenDir(h.path(dataDirectory + "/global"))
	if err != nil {
		return "", err
	}
	defer dir.Close()
	data, _, err := dir.ReadFile("pg_control", 16384)
	if err != nil {
		return "", err
	}
	if len(data) < 8 {
		return "", errors.New("helper: pg_control is too short")
	}
	return strconv.FormatUint(binary.NativeEndian.Uint64(data[:8]), 10), nil
}

// file opens the directory of an operator-configured file path.
func (h *Helper) file(path string) (*fsafe.Dir, string, *Refusal) {
	dirPath, name, err := fsafe.Split(path)
	if err != nil {
		return nil, "", refuse(CodeNotConfigured, "a configured path is not a file path")
	}
	dir, err := fsafe.OpenDir(h.path(dirPath))
	if err != nil {
		return nil, "", refuse(CodePreconditionFailed, "the directory of a managed file cannot be opened safely")
	}
	return dir, name, nil
}

// dataOwner is the owner of the instance's data directory: the PostgreSQL
// server's user, which owns the files the helper creates for it.
func (h *Helper) dataOwner(in config.Instance) (fsafe.Owner, *Refusal) {
	dir, err := fsafe.OpenDir(h.path(in.DataDirectory))
	if err != nil {
		return fsafe.Owner{}, refuse(CodePreconditionFailed, "the data directory cannot be opened safely")
	}
	defer dir.Close()
	o, err := dir.Owner()
	if err != nil || o.UID == 0 {
		return fsafe.Owner{}, refuse(CodePreconditionFailed, "the data directory owner is not a PostgreSQL user")
	}
	return o, nil
}

// ----- service.status, service.restart -----

type unitKind struct{ unit, kind string }

func serviceStatus(ctx context.Context, h *Helper, _ *verify.Job) (canon.Object, *Refusal) {
	var units []unitKind
	for _, in := range h.Config.Instances {
		if unitRE.MatchString(in.Unit) {
			units = append(units, unitKind{in.Unit, "postgresql"})
		}
	}
	units = append(units, unitKind{AgentUnit, "agent"}, unitKind{HelperUnit, "helper"})
	args := []string{"show", "--timestamp=unix", "--property=Id,LoadState,ActiveState,SubState,StateChangeTimestamp", "--"}
	for _, u := range units {
		args = append(args, u.unit)
	}
	out, err := h.Runner.Run(ctx, Command{Path: Systemctl, Args: args})
	if err != nil || out.ExitCode != 0 {
		return nil, refuse(CodeFailed, "systemctl show failed")
	}
	blocks := parseShow(out.Stdout)
	list := canon.Array{}
	for _, u := range units {
		props, ok := blocks[u.unit]
		if !ok {
			return nil, refuse(CodeFailed, "systemctl show did not report %s", u.unit)
		}
		// since: the last state change, whatever the state (Phase 4 review).
		since := canon.Value(canon.Null{})
		if ts := strings.TrimPrefix(props["StateChangeTimestamp"], "@"); ts != "" && ts != "0" {
			if n, err := strconv.ParseInt(ts, 10, 64); err == nil && n > 0 {
				since = canon.String(time.Unix(n, 0).UTC().Format(time.RFC3339))
			}
		}
		// A unit that is not loaded (not-found, masked, bad-setting) reports
		// its LoadState instead of the inactive/dead systemd shows for it.
		active, sub := bounded(props["ActiveState"], 32), bounded(props["SubState"], 32)
		if load := props["LoadState"]; load != "loaded" {
			active, sub = bounded(load, 32), "unloaded"
		}
		list = append(list, canon.Object{
			{Name: "unit", Value: canon.String(u.unit)},
			{Name: "kind", Value: canon.String(u.kind)},
			{Name: "activeState", Value: canon.String(active)},
			{Name: "subState", Value: canon.String(sub)},
			{Name: "since", Value: since},
		})
	}
	return canon.Object{{Name: "units", Value: list}}, nil
}

// parseShow reads `systemctl show` output: blocks of Key=Value lines
// separated by an empty line, keyed by their Id.
func parseShow(out []byte) map[string]map[string]string {
	blocks := map[string]map[string]string{}
	cur := map[string]string{}
	flush := func() {
		if id := cur["Id"]; id != "" {
			blocks[id] = cur
		}
		cur = map[string]string{}
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok {
			cur[k] = v
		}
	}
	flush()
	return blocks
}

// bounded keeps printable ASCII and at most n bytes of a host value.
func bounded(s string, n int) string {
	var b strings.Builder
	for _, r := range s {
		if r < 0x20 || r > 0x7e || b.Len() >= n {
			break
		}
		b.WriteRune(r)
	}
	if b.Len() == 0 {
		return "unknown"
	}
	return b.String()
}

func serviceRestart(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	var args struct {
		Cluster      clusterRef `json:"cluster"`
		ShutdownMode string     `json:"shutdownMode"`
	}
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	if args.ShutdownMode != "fast" {
		return nil, refuse(CodeJobInvalid, "only a fast shutdown is supported")
	}
	in, r := h.instance(args.Cluster)
	if r != nil {
		return nil, r
	}
	// At most one restart per interval on this host, whoever asks (threat
	// model T31): a flood of signed restart jobs cannot keep PostgreSQL down.
	// (A replay is refused as such by admitEffect.)
	if last := h.Ledger.LastAt(OpServiceRestart); !last.IsZero() && len(h.Ledger.Ops(job.JobID)) == 0 {
		if since := h.Clock.Now().Sub(last); since < h.Config.RestartInterval() {
			return nil, refuse(CodeFailed, "a restart ran %s ago; the operator allows one per %s",
				since.Round(time.Second), h.Config.RestartInterval())
		}
	}
	if r := h.admitEffect(OpServiceRestart, job); r != nil {
		return nil, r
	}
	// The Debian postgresql@ unit stops with pg_ctlcluster's fast mode.
	out, err := h.Runner.Run(ctx, Command{Path: Systemctl, Args: []string{"restart", "--", in.Unit}, Timeout: restartTimeout})
	if errors.Is(err, context.DeadlineExceeded) {
		// systemd's job may still be running: the outcome is unknown, and
		// the postmaster start time decides it (Phase 4 review).
		return nil, refuse(CodeOutcomeUnknown, "systemctl restart %s did not finish in time", in.Unit)
	}
	if err != nil || out.ExitCode != 0 {
		return nil, refuse(CodeFailed, "systemctl restart %s failed", in.Unit)
	}
	return canon.Object{{Name: "unit", Value: canon.String(in.Unit)}}, nil
}

// ----- config.patch_fragment (OD-20, capabilities.md §6) -----

func configPatchFragment(_ context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	var args struct {
		Cluster                clusterRef       `json:"cluster"`
		Changes                []pgfiles.Change `json:"changes"`
		ExpectedFragmentDigest *string          `json:"expectedFragmentDigest"`
		ConfigVersion          string           `json:"configVersion"`
		Reload                 bool             `json:"reload"`
	}
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	in, r := h.instance(args.Cluster)
	if r != nil {
		return nil, r
	}
	dir, name, r := h.file(in.ManagedInclude)
	if r != nil {
		return nil, r
	}
	defer dir.Close()
	current, st, err := dir.ReadFile(name, maxFile)
	present := err == nil
	if err != nil && !errors.Is(err, fsafe.ErrNotExist) {
		return nil, refuse(CodePreconditionFailed, "the managed fragment cannot be read safely")
	}
	before, r := h.fileDigest(purposeFragment, current, present)
	if r != nil {
		return nil, r
	}
	switch b, _ := before.(canon.String); {
	case args.ExpectedFragmentDigest == nil && present,
		args.ExpectedFragmentDigest != nil && (!present || string(b) != *args.ExpectedFragmentDigest):
		return nil, refuse(CodePreconditionFailed, "the managed fragment changed since the plan")
	}
	// Only the plan's parameters change; every other line stays on the host
	// as it is and never travels (Wave 5 correction F1).
	var base []byte
	if present {
		base = current
	}
	content, err := pgfiles.PatchFragment(base, args.Changes)
	if errors.Is(err, pgfiles.ErrForeign) {
		return nil, refuse(CodePreconditionFailed, "the managed fragment holds lines ExponetDB did not write")
	}
	if err != nil {
		return nil, refuse(CodeJobInvalid, "the parameters cannot be written safely")
	}
	after, r := h.fileDigest(purposeFragment, content, true)
	if r != nil {
		return nil, r
	}
	owner := fsafe.Owner{UID: st.UID, GID: st.GID, Mode: st.Mode}
	if !present {
		data, r := h.dataOwner(in)
		if r != nil {
			return nil, r
		}
		owner = fsafe.Owner{UID: data.UID, GID: data.GID, Mode: 0o640}
	}
	if r := h.admitEffect(OpConfigPatchFragment, job); r != nil {
		return nil, r
	}
	if err := dir.Replace(name, content, owner); err != nil {
		return nil, refuse(CodeFailed, "the managed fragment could not be written")
	}
	return canon.Object{
		{Name: "fragmentDigest", Value: after},
		{Name: "previousFragmentDigest", Value: before},
	}, nil
}

// ----- files.digest -----

// The purposes of the helper's keyed file digests (kd1).
const (
	purposeFragment = "exponetdb/helper-file/managed-fragment/v1"
	purposeHbaFile  = "exponetdb/helper-file/pg_hba/v1"
)

// fileDigest is the helper's keyed digest of a file's content (null when the
// file is absent); without the helper's key nothing is exported.
func (h *Helper) fileDigest(purpose string, data []byte, present bool) (canon.Value, *Refusal) {
	if !present {
		return canon.Null{}, nil
	}
	d, err := kdigest.Of(h.DigestKey, purpose, data)
	if err != nil {
		return nil, refuse(CodeNotConfigured, "the helper has no digest key")
	}
	return canon.String(d), nil
}

// filesDigest reports, for the job's cluster, the keyed digests of the
// managed fragment and of pg_hba.conf: the values a plan binds and the
// helper's writes check (capabilities.md §6). Nothing of the content.
func filesDigest(_ context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	// The arguments of the three reads it serves (the guard checked them
	// against their capability's schema); only the cluster is used.
	var args struct {
		Cluster clusterRef      `json:"cluster"`
		Changes json.RawMessage `json:"changes"`
	}
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	in, r := h.instance(args.Cluster)
	if r != nil {
		return nil, r
	}
	read := func(path string) ([]byte, bool, *Refusal) {
		dir, name, r := h.file(path)
		if r != nil {
			return nil, false, r
		}
		defer dir.Close()
		data, _, err := dir.ReadFile(name, maxFile)
		if errors.Is(err, fsafe.ErrNotExist) {
			return nil, false, nil
		}
		if err != nil {
			return nil, false, refuse(CodePreconditionFailed, "a managed file cannot be read safely")
		}
		return data, true, nil
	}
	fragment, fragmentPresent, r := read(in.ManagedInclude)
	if r != nil {
		return nil, r
	}
	hba, hbaPresent, r := read(in.HbaFile)
	if r != nil {
		return nil, r
	}
	if !hbaPresent {
		return nil, refuse(CodePreconditionFailed, "pg_hba.conf is missing")
	}
	fd, r := h.fileDigest(purposeFragment, fragment, fragmentPresent)
	if r != nil {
		return nil, r
	}
	hd, r := h.fileDigest(purposeHbaFile, hba, true)
	if r != nil {
		return nil, r
	}
	return canon.Object{
		{Name: "fragment", Value: canon.Object{
			{Name: "present", Value: canon.Bool(fragmentPresent)},
			{Name: "digest", Value: fd},
		}},
		{Name: "hbaFile", Value: hd},
	}, nil
}

// ----- hba.write, hba.restore -----

// hbaArgs: protectedAccess is the agent's check (pg_hba_file_rules before
// the reload); the helper only renders the rules.
type hbaArgs struct {
	Cluster            clusterRef        `json:"cluster"`
	ManagedRules       []pgfiles.HbaRule `json:"managedRules"`
	ExpectedFileDigest string            `json:"expectedFileDigest"`
	ProtectedAccess    []struct {
		Role     string `json:"role"`
		Database string `json:"database"`
		Address  string `json:"address"`
		Method   string `json:"method"`
	} `json:"protectedAccess"`
}

func hbaWrite(_ context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	var args hbaArgs
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	in, r := h.instance(args.Cluster)
	if r != nil {
		return nil, r
	}
	block, err := pgfiles.RenderHbaBlock(args.ManagedRules)
	if err != nil {
		return nil, refuse(CodeJobInvalid, "the rules cannot be written safely")
	}
	dir, name, r := h.file(in.HbaFile)
	if r != nil {
		return nil, r
	}
	defer dir.Close()
	current, st, err := dir.ReadFile(name, maxFile)
	if err != nil {
		return nil, refuse(CodePreconditionFailed, "pg_hba.conf cannot be read safely")
	}
	before, r := h.fileDigest(purposeHbaFile, current, true)
	if r != nil {
		return nil, r
	}
	if b, _ := before.(canon.String); string(b) != args.ExpectedFileDigest {
		return nil, refuse(CodePreconditionFailed, "pg_hba.conf changed since the plan")
	}
	next, err := pgfiles.SpliceHba(current, block)
	if err != nil {
		return nil, refuse(CodePreconditionFailed, "pg_hba.conf has ambiguous managed block markers")
	}
	after, r := h.fileDigest(purposeHbaFile, next, true)
	if r != nil {
		return nil, r
	}
	if r := h.admitEffect(OpHbaWrite, job); r != nil {
		return nil, r
	}
	if err := dir.Replace(name, next, fsafe.Owner{UID: st.UID, GID: st.GID, Mode: st.Mode}); err != nil {
		return nil, refuse(CodeFailed, "pg_hba.conf could not be written")
	}
	return canon.Object{
		{Name: "fileDigest", Value: after},
		{Name: "previousFileDigest", Value: before},
	}, nil
}

// hbaRestore puts back the file this job's write replaced, and only while
// the file is still exactly what the write produced from it.
func hbaRestore(_ context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	if done := h.Ledger.Ops(job.JobID); len(done) != 1 || done[0] != OpHbaWrite {
		return nil, refuse(CodeReplayed, "a restore follows only this job's write, once")
	}
	var args hbaArgs
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	in, r := h.instance(args.Cluster)
	if r != nil {
		return nil, r
	}
	block, err := pgfiles.RenderHbaBlock(args.ManagedRules)
	if err != nil {
		return nil, refuse(CodeJobInvalid, "the rules cannot be written safely")
	}
	dir, name, r := h.file(in.HbaFile)
	if r != nil {
		return nil, r
	}
	defer dir.Close()
	current, _, err1 := dir.ReadFile(name, maxFile)
	previous, _, err2 := dir.ReadFile(name+fsafe.PreviousSuffix, maxFile)
	if err1 != nil || err2 != nil {
		return nil, refuse(CodePreconditionFailed, "pg_hba.conf or its previous content cannot be read safely")
	}
	written, err := pgfiles.SpliceHba(previous, block)
	before, r := h.fileDigest(purposeHbaFile, previous, true)
	if r != nil {
		return nil, r
	}
	if b, _ := before.(canon.String); err != nil || string(b) != args.ExpectedFileDigest || !bytes.Equal(written, current) {
		return nil, refuse(CodePreconditionFailed, "pg_hba.conf is not what this job wrote")
	}
	if r := h.admitEffect(OpHbaRestore, job); r != nil {
		return nil, r
	}
	if err := dir.Restore(name); err != nil {
		return nil, refuse(CodeFailed, "pg_hba.conf could not be restored")
	}
	return canon.Object{{Name: "fileDigest", Value: before}}, nil
}

// ----- trust.update (config.update@1) -----

// trustUpdate applies a config.update@1 job's key changes to the helper's
// own trust, as the agent applies them to its state; the gateway address is
// the agent's alone.
func trustUpdate(_ context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	var args struct {
		Gateway *struct {
			URL        string `json:"url"`
			ServerName string `json:"serverName"`
		} `json:"gateway"`
		AddJobKeys    []state.JobKey `json:"addJobKeys"`
		RetireJobKeys []string       `json:"retireJobKeys"`
	}
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	cur, err := h.trust()
	if err != nil {
		return nil, refuse(CodeNotConfigured, "the helper has no trust")
	}
	// Toward the job's target set: a key already trusted with the same public
	// key is not added again, a key no longer trusted is not retired again, so
	// a new job converges after a partial update (an agent that stopped
	// between the helper's trust and its own state).
	retire := map[string]bool{}
	for _, id := range args.RetireJobKeys {
		retire[id] = true
	}
	next := *cur
	next.JobKeys = nil
	for _, k := range cur.JobKeys {
		if !retire[k.KeyID] {
			next.JobKeys = append(next.JobKeys, k)
		}
	}
	for _, add := range args.AddJobKeys {
		present := false
		for _, k := range next.JobKeys {
			if k.KeyID == add.KeyID {
				if k.PublicKey != add.PublicKey {
					return nil, refuse(CodePreconditionFailed, "the job names a trusted key id with another public key")
				}
				present = true
			}
		}
		if !present {
			next.JobKeys = append(next.JobKeys, add)
		}
	}
	if err := next.Validate(); err != nil {
		return nil, refuse(CodePreconditionFailed, "the resulting trust is invalid")
	}
	if r := h.admitEffect(OpTrustUpdate, job); r != nil {
		return nil, r
	}
	if err := SaveTrust(h.TrustPath, &next); err != nil {
		return nil, refuse(CodeFailed, "the helper trust could not be written")
	}
	keys := canon.Array{}
	for _, k := range next.JobKeys {
		keys = append(keys, canon.String(k.KeyID))
	}
	return canon.Object{{Name: "jobKeys", Value: keys}}, nil
}

// trustInspect reports the helper's own job keys (agent.diagnostics@2). The
// job itself was verified against them, so a job a new key signed proves the
// helper trusts that key.
func trustInspect(_ context.Context, h *Helper, _ *verify.Job) (canon.Object, *Refusal) {
	cur, err := h.trust()
	if err != nil {
		return nil, refuse(CodeNotConfigured, "the helper has no trust")
	}
	keys := canon.Array{}
	for _, k := range cur.JobKeys {
		keys = append(keys, canon.String(k.KeyID))
	}
	return canon.Object{{Name: "jobKeys", Value: keys}}, nil
}

// ----- system.failed_units (system.health@1) -----

var unitNameRE = regexp.MustCompile(`^[A-Za-z0-9:_.@\\-]{1,256}$`)

func failedUnits(ctx context.Context, h *Helper, _ *verify.Job) (canon.Object, *Refusal) {
	out, err := h.Runner.Run(ctx, Command{Path: Systemctl, Args: []string{"list-units", "--failed", "--plain", "--no-legend", "--no-pager", "--full"}})
	if err != nil || out.ExitCode != 0 {
		return nil, refuse(CodeFailed, "systemctl list-units failed")
	}
	units := canon.Array{}
	for _, line := range strings.Split(string(out.Stdout), "\n") {
		f := strings.Fields(line)
		if len(f) == 0 || !unitNameRE.MatchString(f[0]) || len(units) == 64 {
			continue
		}
		units = append(units, canon.String(f[0]))
	}
	return canon.Object{{Name: "units", Value: units}}, nil
}

// ----- log.read (log.inspect@2 for the agent's and the helper's units) -----

func logRead(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	var args struct {
		Source      string      `json:"source"`
		Cluster     *clusterRef `json:"cluster"`
		Since       string      `json:"since"`
		Until       string      `json:"until"`
		MinSeverity string      `json:"minSeverity"`
		MaxLines    int         `json:"maxLines"`
	}
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	unit := map[string]string{"agent": AgentUnit, "helper": HelperUnit}[args.Source]
	if unit == "" {
		return nil, refuse(CodeOperationMismatch, "the helper reads only the agent's and its own journal")
	}
	since, err1 := time.Parse(time.RFC3339Nano, args.Since)
	until, err2 := time.Parse(time.RFC3339Nano, args.Until)
	if err1 != nil || err2 != nil || args.MaxLines < 1 || args.MaxLines > 500 {
		return nil, refuse(CodeJobInvalid, "the log window is invalid")
	}
	out, err := h.Runner.Run(ctx, Command{Path: Journalctl, Args: []string{
		"--unit=" + unit, "--since=@" + strconv.FormatInt(since.Unix(), 10), "--until=@" + strconv.FormatInt(until.Unix()+1, 10),
		"--output=json", "--output-fields=MESSAGE,PRIORITY", "--no-pager", "--quiet", "--lines=" + strconv.Itoa(args.MaxLines),
	}})
	if err != nil || out.ExitCode != 0 {
		return nil, refuse(CodeFailed, "journalctl failed")
	}
	priorities := []string{"panic", "fatal", "fatal", "error", "warning", "notice", "info", "debug"}
	lines := canon.Array{}
	for _, raw := range strings.Split(string(out.Stdout), "\n") {
		if raw == "" {
			continue
		}
		var entry map[string]json.RawMessage
		if json.Unmarshal([]byte(raw), &entry) != nil {
			continue
		}
		var message, priority, realtime string
		if json.Unmarshal(entry["MESSAGE"], &message) != nil {
			message = "[binary message]"
		}
		_ = json.Unmarshal(entry["PRIORITY"], &priority)
		_ = json.Unmarshal(entry["__REALTIME_TIMESTAMP"], &realtime)
		at := canon.Value(canon.Null{})
		if us, err := strconv.ParseInt(realtime, 10, 64); err == nil {
			at = canon.String(time.UnixMicro(us).UTC().Format(time.RFC3339Nano))
		}
		severity := "info"
		if p, err := strconv.Atoi(priority); err == nil && p >= 0 && p < len(priorities) {
			severity = priorities[p]
		}
		if len(message) > 2048 {
			message = strings.ToValidUTF8(message[:2048], "")
		}
		lines = append(lines, canon.Object{
			{Name: "at", Value: at}, {Name: "severity", Value: canon.String(severity)}, {Name: "text", Value: canon.String(message)},
		})
	}
	return canon.Object{{Name: "lines", Value: lines}}, nil
}

package helper

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsafe"
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

func digestOrNull(data []byte, present bool) canon.Value {
	if !present {
		return canon.Null{}
	}
	return canon.String(pgfiles.Digest(data))
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

// ----- config.write_fragment (OD-20) -----

func configWriteFragment(_ context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	var args struct {
		Cluster                clusterRef          `json:"cluster"`
		Parameters             []pgfiles.Parameter `json:"parameters"`
		ExpectedFragmentDigest *string             `json:"expectedFragmentDigest"`
		ConfigVersion          string              `json:"configVersion"`
		Reload                 bool                `json:"reload"`
	}
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	in, r := h.instance(args.Cluster)
	if r != nil {
		return nil, r
	}
	content, err := pgfiles.RenderFragment(args.Parameters)
	if err != nil {
		return nil, refuse(CodeJobInvalid, "the parameters cannot be written safely")
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
	switch {
	case args.ExpectedFragmentDigest == nil && present,
		args.ExpectedFragmentDigest != nil && (!present || pgfiles.Digest(current) != *args.ExpectedFragmentDigest):
		return nil, refuse(CodePreconditionFailed, "the managed fragment changed since the plan")
	}
	owner := fsafe.Owner{UID: st.UID, GID: st.GID, Mode: st.Mode}
	if !present {
		data, r := h.dataOwner(in)
		if r != nil {
			return nil, r
		}
		owner = fsafe.Owner{UID: data.UID, GID: data.GID, Mode: 0o640}
	}
	if r := h.admitEffect(OpConfigWriteFragment, job); r != nil {
		return nil, r
	}
	if err := dir.Replace(name, content, owner); err != nil {
		return nil, refuse(CodeFailed, "the managed fragment could not be written")
	}
	return canon.Object{
		{Name: "fragmentDigest", Value: canon.String(pgfiles.Digest(content))},
		{Name: "previousFragmentDigest", Value: digestOrNull(current, present)},
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
	if pgfiles.Digest(current) != args.ExpectedFileDigest {
		return nil, refuse(CodePreconditionFailed, "pg_hba.conf changed since the plan")
	}
	next, err := pgfiles.SpliceHba(current, block)
	if err != nil {
		return nil, refuse(CodePreconditionFailed, "pg_hba.conf has ambiguous managed block markers")
	}
	if r := h.admitEffect(OpHbaWrite, job); r != nil {
		return nil, r
	}
	if err := dir.Replace(name, next, fsafe.Owner{UID: st.UID, GID: st.GID, Mode: st.Mode}); err != nil {
		return nil, refuse(CodeFailed, "pg_hba.conf could not be written")
	}
	return canon.Object{
		{Name: "fileDigest", Value: canon.String(pgfiles.Digest(next))},
		{Name: "previousFileDigest", Value: canon.String(pgfiles.Digest(current))},
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
	if err != nil || pgfiles.Digest(previous) != args.ExpectedFileDigest || !bytes.Equal(written, current) {
		return nil, refuse(CodePreconditionFailed, "pg_hba.conf is not what this job wrote")
	}
	if r := h.admitEffect(OpHbaRestore, job); r != nil {
		return nil, r
	}
	if err := dir.Restore(name); err != nil {
		return nil, refuse(CodeFailed, "pg_hba.conf could not be restored")
	}
	return canon.Object{{Name: "fileDigest", Value: canon.String(pgfiles.Digest(previous))}}, nil
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
	retire := map[string]bool{}
	for _, id := range args.RetireJobKeys {
		found := false
		for _, k := range cur.JobKeys {
			found = found || k.KeyID == id
		}
		if !found {
			return nil, refuse(CodePreconditionFailed, "the job retires a key the helper does not trust")
		}
		retire[id] = true
	}
	next := *cur
	next.JobKeys = nil
	for _, k := range cur.JobKeys {
		if !retire[k.KeyID] {
			next.JobKeys = append(next.JobKeys, k)
		}
	}
	next.JobKeys = append(next.JobKeys, args.AddJobKeys...)
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

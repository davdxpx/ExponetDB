package helper

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsafe"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// The Wave 9 Part B operations (ADR-0036, ADR-0037, ADR-0038).

// ----- the engine directories -----

func (h *Helper) rootOwner(mode os.FileMode) fsafe.Owner {
	gid := 0
	if h.Root != "" {
		gid = os.Getegid()
	}
	return fsafe.Owner{UID: h.rootUID(), GID: gid, Mode: mode}
}

// engineDir opens <engine>/<sub> (runs or scratch), creating it root-owned
// and 0711 when create is set. The engine directory and sub must belong to
// root and be writable by no one else; no symlink on the path.
func (h *Helper) engineDir(sub string, create bool) (*fsafe.Dir, *Refusal) {
	base, err := fsafe.OpenDir(h.path(h.paths().Engine))
	if err != nil {
		if errors.Is(err, syscall.ENOENT) && !create {
			return nil, nil
		}
		return nil, refuse(CodeNotConfigured, "the engine directory is missing or not safe")
	}
	defer base.Close()
	if r := h.trustedDir(base); r != nil {
		return nil, r
	}
	info, err := base.Lstat(sub)
	if err != nil {
		return nil, refuse(CodeFailed, "the engine directory cannot be read")
	}
	if info.Kind == fsafe.KindNone {
		if !create {
			return nil, nil
		}
		if err := base.Mkdir(sub, h.rootOwner(0o711)); err != nil && !errors.Is(err, fsafe.ErrExist) {
			return nil, refuse(CodeFailed, "the engine directory could not be prepared")
		}
	}
	d, err := base.OpenDir(sub)
	if err != nil {
		return nil, refuse(CodePreconditionFailed, "the engine's %s directory is a symlink or not a directory", sub)
	}
	if r := h.trustedDir(d); r != nil {
		d.Close()
		return nil, r
	}
	return d, nil
}

// readRecord reads runs/<runID>/record.json (root-owned, no one else can
// write it). A missing run directory is (nil, nil, nil).
func (h *Helper) readRecord(runs *fsafe.Dir, runID string) (*runRecord, *fsafe.Dir, *Refusal) {
	if runs == nil {
		return nil, nil, nil
	}
	runDir, err := runs.OpenDir(runID)
	if errors.Is(err, fsafe.ErrNotExist) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, refuse(CodePreconditionFailed, "the run directory is a symlink or not a directory")
	}
	data, st, err := runDir.ReadFile("record.json", 1<<20)
	if errors.Is(err, fsafe.ErrNotExist) {
		// A run directory without its record: a start that stopped before it
		// wrote the record. The run never started.
		return nil, runDir, nil
	}
	var rec runRecord
	if err != nil || st.UID != h.rootUID() || st.Mode&0o022 != 0 || decodeStrict(data, &rec) != nil ||
		rec.validate() != nil || rec.RunID != runID {
		runDir.Close()
		return nil, nil, refuse(CodeFailed, "the run record cannot be read")
	}
	return &rec, runDir, nil
}

// readResult reads the helper's result.json of a run (nil: none yet).
func (h *Helper) readResult(runDir *fsafe.Dir) (canon.Object, error) {
	data, st, err := runDir.ReadFile("result.json", 1<<20)
	if errors.Is(err, fsafe.ErrNotExist) {
		return nil, nil
	}
	if err != nil || st.UID != h.rootUID() || st.Mode&0o022 != 0 {
		return nil, errors.New("helper: the run result cannot be read")
	}
	v, err := canon.Parse(data)
	o, ok := v.(canon.Object)
	if err != nil || !ok {
		return nil, errors.New("helper: the run result cannot be read")
	}
	return o, nil
}

func (h *Helper) writeResult(runDir *fsafe.Dir, result canon.Object) error {
	data, err := canon.Canonicalize(result)
	if err != nil {
		return err
	}
	if err := runDir.Create("result.json", data, h.rootOwner(0o600)); err != nil && !errors.Is(err, syscall.EEXIST) {
		return err
	}
	return nil
}

func nullOr(v canon.Value, ok bool) canon.Value {
	if !ok {
		return canon.Null{}
	}
	return v
}

// terminalResult is a result record: the run's end as the helper saw it.
func terminalResult(state, finishedAt string, exitCode *int, excerpt string, progress, outcome canon.Value) canon.Object {
	exit := canon.Value(canon.Null{})
	if exitCode != nil {
		exit = canon.Number(*exitCode)
	}
	fin := canon.Value(canon.Null{})
	if finishedAt != "" {
		fin = canon.String(finishedAt)
	}
	if progress == nil {
		progress = canon.Null{}
	}
	if outcome == nil {
		outcome = canon.Null{}
	}
	return canon.Object{
		{Name: "state", Value: canon.String(state)},
		{Name: "finishedAt", Value: fin},
		{Name: "exitCode", Value: exit},
		{Name: "progress", Value: progress},
		{Name: "excerpt", Value: canon.String(excerpt)},
		{Name: "outcome", Value: outcome},
	}
}

// readOutcome reads work/outcome.json, which the engine user wrote: every
// value is checked and bounded again.
func readOutcome(runDir *fsafe.Dir) (*runOutcome, canon.Value, bool) {
	work, err := runDir.OpenDir("work")
	if err != nil {
		return nil, nil, false
	}
	defer work.Close()
	data, _, err := work.ReadFile("outcome.json", 256*1024)
	if err != nil {
		return nil, nil, false
	}
	var o runOutcome
	if decodeStrict(data, &o) != nil || o.Schema != OutcomeSchema {
		return &runOutcome{State: "failed", Excerpt: "the engine run's outcome is not readable"}, canon.Null{}, true
	}
	return &o, outcomeValue(&o), true
}

func outcomeValue(o *runOutcome) canon.Value {
	label := canon.Value(canon.Null{})
	if o.Label != nil && len(*o.Label) <= 128 && (labelRE.MatchString(*o.Label) || snapshotRE.MatchString(*o.Label)) {
		label = canon.String(*o.Label)
	}
	verifyErrors := canon.Value(canon.Null{})
	if o.VerifyErrors != nil && *o.VerifyErrors >= 0 {
		verifyErrors = canon.Number(*o.VerifyErrors)
	}
	reachedAt := canon.Value(canon.Null{})
	if o.RecoveryReachedAt != nil {
		reachedAt = resticTime(*o.RecoveryReachedAt)
	}
	timeline := canon.Value(canon.Null{})
	if o.Timeline != nil && *o.Timeline >= 1 && *o.Timeline <= 1<<31 {
		timeline = canon.Number(*o.Timeline)
	}
	port := canon.Value(canon.Null{})
	if o.Port != nil && *o.Port >= 55400 && *o.Port <= 55499 {
		port = canon.Number(*o.Port)
	}
	checks := canon.Array{}
	for _, c := range o.Checks {
		if len(checks) == 16 {
			break
		}
		if !oneOf(c.Check, "recovery_target_reached", "probe_simple", "probe_extended", "amcheck", "row_counts", "fingerprint_inputs") ||
			!oneOf(c.Outcome, "passed", "failed", "not_run", "error") {
			continue
		}
		detail := canon.Value(canon.Null{})
		if c.Detail != nil {
			detail = canon.String(Redact(*c.Detail, 512))
		}
		checks = append(checks, canon.Object{{Name: "check", Value: canon.String(c.Check)}, {Name: "outcome", Value: canon.String(c.Outcome)}, {Name: "detail", Value: detail}})
	}
	phases := canon.Array{}
	for _, p := range o.Phases {
		if len(phases) == 8 {
			break
		}
		started := resticTime(p.StartedAt)
		if _, isNull := started.(canon.Null); isNull || !oneOf(p.Name, "restore", "recover", "verify", "stop") || !oneOf(p.Outcome, "running", "passed", "failed") {
			continue
		}
		finished := canon.Value(canon.Null{})
		if p.FinishedAt != nil {
			finished = resticTime(*p.FinishedAt)
		}
		phases = append(phases, canon.Object{{Name: "name", Value: canon.String(p.Name)}, {Name: "startedAt", Value: started},
			{Name: "finishedAt", Value: finished}, {Name: "outcome", Value: canon.String(p.Outcome)}})
	}
	return canon.Object{
		{Name: "label", Value: label},
		{Name: "verifyErrors", Value: verifyErrors},
		{Name: "recoveryReachedLsn", Value: optPattern(lsnRE, o.RecoveryReachedLsn, true)},
		{Name: "recoveryReachedAt", Value: reachedAt},
		{Name: "timeline", Value: timeline},
		{Name: "port", Value: port},
		{Name: "checks", Value: checks},
		{Name: "phases", Value: phases},
	}
}

func oneOf(s string, list ...string) bool {
	for _, x := range list {
		if s == x {
			return true
		}
	}
	return false
}

func readProgress(runDir *fsafe.Dir) canon.Value {
	work, err := runDir.OpenDir("work")
	if err != nil {
		return canon.Null{}
	}
	defer work.Close()
	data, _, err := work.ReadFile("progress.json", 4096)
	var p runProgress
	if err != nil || decodeStrict(data, &p) != nil {
		return canon.Null{}
	}
	percent, bytes := canon.Value(canon.Null{}), canon.Value(canon.Null{})
	if p.Percent != nil && *p.Percent >= 0 && *p.Percent <= 100 {
		percent = canon.Number(*p.Percent)
	}
	if p.Bytes != nil && *p.Bytes >= 0 {
		bytes = canon.Number(*p.Bytes)
	}
	return canon.Object{{Name: "percent", Value: percent}, {Name: "bytes", Value: bytes}}
}

// collect decides a run's state from its unit and the engine's outcome; a
// terminal state is written to result.json (once) and the run's secrets are
// removed. It returns the result record (state, finishedAt, exitCode,
// progress, excerpt, outcome).
func (h *Helper) collect(rec *runRecord, runDir *fsafe.Dir, st unitState) canon.Object {
	if res, err := h.readResult(runDir); err == nil && res != nil {
		return res
	}
	if st.Active {
		state := "running"
		if st.ActiveText == "activating" {
			state = "starting"
		}
		return terminalResult(state, "", nil, "", readProgress(runDir), nil)
	}
	now := h.Clock.Now().UTC()
	var result canon.Object
	if o, outcome, ok := readOutcome(runDir); ok {
		state := o.State
		if !oneOf(state, "succeeded", "failed", "canceled") {
			state = "failed"
		}
		finished := ""
		if v, isString := resticTime(o.FinishedAt).(canon.String); isString {
			finished = string(v)
		}
		exit := o.ExitCode
		if exit != nil && (*exit < -1 || *exit > 255) {
			exit = nil
		}
		result = terminalResult(state, finished, exit, Redact(o.Excerpt, 2048), readProgress(runDir), outcome)
	} else {
		started, _ := time.Parse(time.RFC3339, rec.StartedAt)
		if !st.Loaded && now.Sub(started) < startGrace {
			return terminalResult("starting", "", nil, "", nil, nil)
		}
		if st.Loaded {
			msg := "the engine run ended without an outcome (systemd result " + st.Result + ")"
			if _, _, err := runDir.ReadFile("cancel.json", 4096); err == nil {
				msg = "the engine run was stopped on a cancel request without an outcome; its effect is unknown"
			}
			result = terminalResult("failed", now.Format(time.RFC3339), st.ExitStatus, msg, nil, nil)
		} else {
			result = terminalResult("lost", "", nil, "the run's unit is gone without an outcome (a host restart stops runs)", nil, nil)
		}
	}
	h.removeSecrets(runDir)
	if h.writeResult(runDir, result) != nil {
		// Reported, not recorded: the next read decides again.
		return result
	}
	if res, err := h.readResult(runDir); err == nil && res != nil {
		return res
	}
	return result
}

func (h *Helper) removeSecrets(runDir *fsafe.Dir) {
	_, _ = runDir.RemoveAll(context.Background(), "private")
	work, err := runDir.OpenDir("work")
	if err != nil {
		return
	}
	defer work.Close()
	_, _ = work.RemoveAll(context.Background(), "secrets")
}

// activeRuns finds the runs that are not terminal, settling the ones that
// ended (their result is written). It reports whether a run of the cluster
// and domain is starting or running, and whether any run uses scratch.
func (h *Helper) activeRuns(ctx context.Context, runs *fsafe.Dir, sysid, domain, scratch string) (bool, *Refusal) {
	if runs == nil {
		return false, nil
	}
	names, err := runs.Names()
	if err != nil {
		return false, refuse(CodeFailed, "the run directory cannot be listed")
	}
	type open struct {
		rec *runRecord
		dir *fsafe.Dir
		bad bool
	}
	var pending []open
	var units []string
	defer func() {
		for _, p := range pending {
			if p.dir != nil {
				p.dir.Close()
			}
		}
	}()
	for _, n := range names {
		if !runIDRE.MatchString(n) {
			continue
		}
		rec, dir, r := h.readRecord(runs, n)
		if r != nil {
			// An unreadable record whose unit runs blocks every start: it
			// may be this cluster's.
			pending = append(pending, open{rec: &runRecord{RunID: n, Unit: UnitName(n)}, bad: true})
			units = append(units, UnitName(n))
			continue
		}
		if rec == nil {
			if dir != nil {
				dir.Close()
			}
			continue
		}
		if res, err := h.readResult(dir); err == nil && res != nil {
			dir.Close()
			continue
		}
		pending = append(pending, open{rec: rec, dir: dir})
		units = append(units, rec.Unit)
	}
	if len(units) == 0 {
		return false, nil
	}
	states, err := h.sup().states(ctx, units)
	if err != nil {
		return false, refuse(CodeFailed, "the state of the runs cannot be read")
	}
	conflict := false
	for _, p := range pending {
		st := states[p.rec.Unit]
		if p.bad {
			conflict = conflict || st.Active
			continue
		}
		res := h.collect(p.rec, p.dir, st)
		state, _ := res.Get("state")
		if s, _ := state.(canon.String); s == "running" || s == "starting" {
			same := p.rec.SystemIdentifier == sysid && p.rec.Domain == domain
			usesScratch := scratch != "" && p.rec.ScratchDirectory == scratch
			conflict = conflict || same || usesScratch
		}
	}
	return conflict, nil
}

// ----- scratch safety -----

func within(child, parent string) bool {
	return child == parent || strings.HasPrefix(child, strings.TrimSuffix(parent, "/")+"/")
}

func resolved(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}

// scratchOverlaps: the scratch path is, contains or lies in the data,
// WAL or tablespace directory of an instance the operator mapped
// (ADR-0038 §3).
func (h *Helper) scratchOverlaps(scratch string) bool {
	scratch = resolved(scratch)
	for _, in := range h.Config.Instances {
		data := h.path(in.DataDirectory)
		dirs := []string{resolved(data), resolved(data + "/pg_wal")}
		if entries, err := os.ReadDir(data + "/pg_tblspc"); err == nil {
			for _, e := range entries {
				dirs = append(dirs, resolved(data+"/pg_tblspc/"+e.Name()))
			}
		}
		for _, d := range dirs {
			if within(scratch, d) || within(d, scratch) {
				return true
			}
		}
	}
	return false
}

// portListening reads the host's TCP listen tables (PID 1's network
// namespace: the helper's own has no network). Unreadable is an error.
func (h *Helper) portListening(port int) (bool, error) {
	read := 0
	for _, f := range []string{"/proc/1/net/tcp", "/proc/1/net/tcp6"} {
		data, err := os.ReadFile(h.path(f))
		if err != nil {
			continue
		}
		read++
		for _, line := range strings.Split(string(data), "\n")[1:] {
			fields := strings.Fields(line)
			if len(fields) < 4 || fields[3] != "0A" {
				continue
			}
			_, hexPort, ok := strings.Cut(fields[1], ":")
			if p, err := strconv.ParseUint(hexPort, 16, 16); ok && err == nil && int(p) == port {
				return true, nil
			}
		}
	}
	if read == 0 {
		return false, errors.New("helper: the host's listen tables cannot be read")
	}
	return false, nil
}

func spaceAvailable(path string) (int64, error) {
	var s syscall.Statfs_t
	if err := syscall.Statfs(path, &s); err != nil {
		return 0, err
	}
	return int64(s.Bavail) * int64(s.Bsize), nil
}

// ----- starting a run -----

type startPlan struct {
	op, purpose, domain string
	runID, sysid        string
	repo                *repository
	repositoryID        string
	engine              string
	user                engineUser
	major               int
	instance            *recordInstance
	newScratch          bool
	scratchDir          string
	scratchRunID        string
	rowCounts           []rowCount
	port                int
}

func (h *Helper) startRun(ctx context.Context, job *verify.Job, p startPlan) (canon.Object, *Refusal) {
	ctx, cancel := context.WithTimeout(ctx, startBudget)
	defer cancel()
	runs, r := h.engineDir("runs", true)
	if r != nil {
		return nil, r
	}
	defer runs.Close()
	if info, err := runs.Lstat(p.runID); err != nil || info.Kind != fsafe.KindNone {
		return nil, refuse(CodePreconditionFailed, "run %s was started already", p.runID)
	}
	var scratchRoot *fsafe.Dir
	if p.newScratch || p.scratchDir != "" {
		if scratchRoot, r = h.engineDir("scratch", true); r != nil {
			return nil, r
		}
		defer scratchRoot.Close()
	}
	scratchPath := p.scratchDir
	if p.newScratch {
		scratchPath = scratchRoot.Path() + "/" + p.runID
		if info, err := scratchRoot.Lstat(p.runID); err != nil || info.Kind != fsafe.KindNone {
			return nil, refuse(CodePreconditionFailed, "the scratch directory of run %s exists", p.runID)
		}
		if h.scratchOverlaps(scratchPath) {
			return nil, refuse(CodePreconditionFailed, "the scratch directory overlaps a data, WAL or tablespace directory")
		}
	}
	if busy, r := h.activeRuns(ctx, runs, p.sysid, p.domain, ""); r != nil {
		return nil, r
	} else if busy {
		return nil, refuse(CodePreconditionFailed, "a %s run of this cluster is active", p.domain)
	}
	if p.port != 0 {
		if p.port < 55400 || p.port > 55499 {
			return nil, refuse(CodeJobInvalid, "the port is outside 55400 to 55499")
		}
		listening, err := h.portListening(p.port)
		if err != nil {
			return nil, refuse(CodeFailed, "the host's listening ports cannot be read")
		}
		if listening {
			return nil, refuse(CodePreconditionFailed, "port %d is in use", p.port)
		}
	}
	args, err := canon.Canonicalize(job.Args)
	if err != nil {
		return nil, refuse(CodeJobInvalid, "the job arguments are not canonical JSON")
	}
	now := h.Clock.Now().UTC().Format(time.RFC3339)
	runPath := runs.Path() + "/" + p.runID
	rec := runRecord{
		Schema: RecordSchema, RunID: p.runID, StartJobID: job.JobID, StartArgsHash: job.ArgsHash, OperationID: job.OperationID,
		Capability: job.Capability, Purpose: p.purpose, Domain: p.domain, SystemIdentifier: p.sysid,
		RepositoryID: p.repositoryID, Engine: p.engine, StartedAt: now, Unit: UnitName(p.runID), EngineUser: p.user,
		PostgresMajor: p.major, PostgresBin: h.path(h.postgresBin(p.major)), Instance: p.instance,
		WorkDirectory: runPath + "/work", ScratchDirectory: scratchPath, ScratchRunID: p.scratchRunID,
		RowCounts: p.rowCounts, Args: args,
	}
	if rec.RowCounts == nil {
		rec.RowCounts = []rowCount{}
	}
	spec := unitSpec{Unit: rec.Unit, RunID: p.runID, Purpose: p.purpose, UID: p.user.UID, GID: p.user.GID,
		ReadWrite: []string{rec.WorkDirectory}}
	if scratchPath != "" {
		spec.ReadWrite = append(spec.ReadWrite, scratchPath)
	}
	if p.repo != nil && p.repo.ref.Engine == "pgbackrest" {
		rec.PgBackRest = &recordPgbr{Config: h.path(p.repo.pgbrConfig), Include: includeOf(h, p.repo), Stanza: p.repo.stanza(), Repo: p.repo.repoIndex()}
		spec.Optional, spec.Bind = pgbrWritable(p.repo.pgbrPaths)
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return nil, refuse(CodeFailed, "the run record cannot be built")
	}
	if r := h.admitEffect(p.op, job); r != nil {
		return nil, r
	}
	// From here on the run exists: its directory, its record, its unit.
	if err := runs.Mkdir(p.runID, fsafe.Owner{UID: h.rootUID(), GID: p.user.GID, Mode: 0o750}); err != nil {
		return nil, refuse(CodeFailed, "the run directory could not be created")
	}
	runDir, err := runs.OpenDir(p.runID)
	if err != nil {
		return nil, refuse(CodeFailed, "the run directory could not be opened")
	}
	defer runDir.Close()
	fail := func(msg string) (canon.Object, *Refusal) {
		h.removeSecrets(runDir)
		_ = h.writeResult(runDir, terminalResult("failed", h.Clock.Now().UTC().Format(time.RFC3339), nil, msg, nil, nil))
		return nil, refuse(CodeFailed, "%s", msg)
	}
	if err := runDir.Mkdir("work", fsafe.Owner{UID: p.user.UID, GID: p.user.GID, Mode: 0o700}); err != nil {
		return fail("the run's work directory could not be created")
	}
	if p.repo != nil && p.repo.logical() {
		env, err := h.writeResticSecrets(runDir, runPath, p.repo, p.user)
		if err != nil {
			return fail("the run's repository files could not be prepared")
		}
		spec.EnvironmentFile = env
	}
	if p.newScratch {
		if err := scratchRoot.Mkdir(p.runID, fsafe.Owner{UID: p.user.UID, GID: p.user.GID, Mode: 0o700}); err != nil {
			return fail("the scratch directory could not be created")
		}
	}
	if err := runDir.Create("record.json", data, fsafe.Owner{UID: h.rootUID(), GID: p.user.GID, Mode: 0o640}); err != nil {
		return fail("the run record could not be written")
	}
	if err := h.sup().start(ctx, spec); err != nil {
		if ctx.Err() != nil {
			// systemd may have started it: the run's state decides.
			return nil, refuse(CodeOutcomeUnknown, "systemd-run did not answer in time; run.status tells whether run %s started", p.runID)
		}
		return fail("the run's unit could not be started")
	}
	return canon.Object{
		{Name: "runId", Value: canon.String(p.runID)},
		{Name: "unit", Value: canon.String(rec.Unit)},
		{Name: "startedAt", Value: canon.String(now)},
	}, nil
}

// pgbrWritable are the paths pgBackRest writes besides the repository: its
// log and spool directories, and its lock directory (bound into the unit's
// private /tmp when it lies there, so the engine's own lock is the host's).
func pgbrWritable(p pgbrPaths) (optional, bind []string) {
	optional = []string{p.log, p.spool}
	if p.repo != "" {
		optional = append(optional, p.repo)
	}
	if within(p.lock, "/tmp") || within(p.lock, "/var/tmp") {
		bind = []string{p.lock}
	} else {
		optional = append(optional, p.lock)
	}
	return optional, bind
}

// writeResticSecrets copies the provisioned repository and password into
// the run's secrets directory (owned by the engine user, 0600) and writes
// the environment file systemd reads for the unit (root, 0600). It returns
// the environment file's path.
func (h *Helper) writeResticSecrets(runDir *fsafe.Dir, runPath string, repo *repository, u engineUser) (string, error) {
	work, err := runDir.OpenDir("work")
	if err != nil {
		return "", err
	}
	defer work.Close()
	private, err := h.privateDir(runDir)
	if err != nil {
		return "", err
	}
	defer private.Close()
	return h.resticSecretsIn(work, runPath+"/work", private, runPath+"/private", repo, u)
}

// privateDir creates <dir>/private, root's and 0700: the environment file
// systemd reads as root never lies in a directory the engine user owns,
// where it could swap the entry before systemd reads it (review finding
// B-5).
func (h *Helper) privateDir(dir *fsafe.Dir) (*fsafe.Dir, error) {
	if err := dir.Mkdir("private", h.rootOwner(0o700)); err != nil {
		return nil, err
	}
	return dir.OpenDir("private")
}

// resticSecretsIn copies the repository and password files into
// secParent/secrets (the engine user's, 0600: restic reads them) and writes
// the environment file into private (root's, 0600). It returns the
// environment file's path.
func (h *Helper) resticSecretsIn(secParent *fsafe.Dir, secParentPath string, private *fsafe.Dir, privatePath string, repo *repository, u engineUser) (string, error) {
	if err := secParent.Mkdir("secrets", fsafe.Owner{UID: u.UID, GID: u.GID, Mode: 0o700}); err != nil {
		return "", err
	}
	sec, err := secParent.OpenDir("secrets")
	if err != nil {
		return "", err
	}
	defer sec.Close()
	owner := fsafe.Owner{UID: u.UID, GID: u.GID, Mode: 0o600}
	if err := sec.Create("repository", append(bytesTrim(repo.resticRepository), '\n'), owner); err != nil {
		return "", err
	}
	if err := sec.Create("password", repo.resticPassword, owner); err != nil {
		return "", err
	}
	secPath := secParentPath + "/secrets"
	env := append([]string{}, repo.resticEnv...)
	env = append(env, "RESTIC_REPOSITORY_FILE="+secPath+"/repository", "RESTIC_PASSWORD_FILE="+secPath+"/password")
	if err := private.Create("env", []byte(strings.Join(env, "\n")+"\n"), h.rootOwner(0o600)); err != nil {
		return "", err
	}
	return privatePath + "/env", nil
}

func bytesTrim(b []byte) []byte { return []byte(strings.TrimSpace(string(b))) }

// ----- the start capabilities -----

type backupArgs struct {
	Cluster    clusterRef    `json:"cluster"`
	Repository repositoryRef `json:"repository"`
	RunID      string        `json:"runId"`
	Kind       string        `json:"kind"`
	Databases  []string      `json:"databases"`
	Label      *string       `json:"label"`
	Snapshot   *string       `json:"snapshot"`
	Retention  *struct {
		FullCount         *int `json:"fullCount"`
		DifferentialCount *int `json:"differentialCount"`
		LogicalDays       *int `json:"logicalDays"`
	} `json:"retention"`
	KeepLabels []string `json:"keepLabels"`
}

// clusterRun resolves what every cluster-bound run needs: the instance (its
// system identifier read from pg_control), its major, the engine user (the
// data directory's owner) and the repository.
func (h *Helper) clusterRun(ctx context.Context, ref clusterRef, repoRef repositoryRef) (startPlan, *Refusal) {
	in, r := h.instance(ref)
	if r != nil {
		return startPlan{}, r
	}
	major, r := h.instanceMajor(in.DataDirectory, in.LocalName)
	if r != nil {
		return startPlan{}, r
	}
	owner, r := h.dataOwner(in)
	if r != nil {
		return startPlan{}, r
	}
	u, r := h.engineUser(owner.UID, owner.GID)
	if r != nil {
		return startPlan{}, r
	}
	repo, r := h.resolveRepository(repoRef, u.UID)
	if r != nil {
		return startPlan{}, r
	}
	if repo.ref.Engine == "pgbackrest" {
		if r := h.checkBinary(PgBackRest); r != nil {
			return startPlan{}, r
		}
		// The stanza must be this cluster's (review finding B-2): a run on
		// cluster A's identity with cluster B's stanza would file B's
		// backups under A and escape the per-cluster run lock.
		s, r := h.pgbrInfo(ctx, repo, u)
		if r != nil {
			return startPlan{}, r
		}
		if id := s.systemID(); id == "" || id != ref.SystemIdentifier {
			return startPlan{}, refuse(CodePreconditionFailed, "the stanza does not belong to cluster %s (system identifier)", ref.LocalName)
		}
	} else if r := h.checkBinary(Restic); r != nil {
		return startPlan{}, r
	}
	return startPlan{
		sysid: ref.SystemIdentifier, repo: repo, repositoryID: repoRef.RepositoryID, engine: repoRef.Engine,
		user: u, major: major, instance: &recordInstance{SocketDirectory: h.path(in.SocketDirectory), Port: in.Port},
	}, nil
}

func backupRun(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	// One budget for the checks and the start (settleSeconds).
	ctx, cancel := context.WithTimeout(ctx, startBudget)
	defer cancel()
	var args backupArgs
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	p, r := h.clusterRun(ctx, args.Cluster, args.Repository)
	if r != nil {
		return nil, r
	}
	logical := args.Kind == "logical"
	switch {
	case logical != p.repo.logical():
		return nil, refuse(CodePreconditionFailed, "a %s backup does not fit a %s repository", args.Kind, args.Repository.Engine)
	case logical && len(args.Databases) == 0:
		return nil, refuse(CodePreconditionFailed, "a logical backup names its databases")
	case !logical && len(args.Databases) > 0:
		return nil, refuse(CodePreconditionFailed, "a physical backup names no databases")
	}
	// The host's two-party control (ADR-0036 §3): adopted_runs allows
	// incremental runs only, owned every kind.
	switch {
	case p.repo.mode == ModeOwned:
	case p.repo.mode == ModeAdoptedRuns && args.Kind == "incremental":
	default:
		return nil, refuse(CodePreconditionFailed, "the host's repository mode %s does not allow a %s backup run", p.repo.mode, args.Kind)
	}
	if logical {
		for _, b := range []string{"pg_dump", "pg_dumpall", "pg_restore"} {
			if r := h.checkBinary(h.postgresBin(p.major) + "/" + b); r != nil {
				return nil, r
			}
		}
	}
	p.op, p.purpose, p.domain, p.runID = OpBackupRun, "backup", "backup", args.RunID
	return h.startRun(ctx, job, p)
}

func backupVerify(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	// One budget for the checks and the start (settleSeconds).
	ctx, cancel := context.WithTimeout(ctx, startBudget)
	defer cancel()
	var args backupArgs
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	p, r := h.clusterRun(ctx, args.Cluster, args.Repository)
	if r != nil {
		return nil, r
	}
	if (args.Label != nil && p.repo.logical()) || (args.Snapshot != nil && !p.repo.logical()) {
		return nil, refuse(CodePreconditionFailed, "a label names a pgBackRest backup, a snapshot a restic one")
	}
	p.op, p.purpose, p.domain, p.runID = OpBackupVerify, "verify", "backup", args.RunID
	return h.startRun(ctx, job, p)
}

func backupExpire(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	// One budget for the checks and the start (settleSeconds).
	ctx, cancel := context.WithTimeout(ctx, startBudget)
	defer cancel()
	var args backupArgs
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	p, r := h.clusterRun(ctx, args.Cluster, args.Repository)
	if r != nil {
		return nil, r
	}
	if p.repo.mode != ModeOwned {
		return nil, refuse(CodePreconditionFailed, "the host's repository mode %s does not allow an expiry", p.repo.mode)
	}
	ret := args.Retention
	switch {
	case ret == nil:
		return nil, refuse(CodeJobInvalid, "an expiry names its retention")
	case !p.repo.logical() && ret.FullCount == nil:
		return nil, refuse(CodePreconditionFailed, "a pgBackRest expiry needs a full retention count")
	case p.repo.logical() && ret.LogicalDays == nil:
		return nil, refuse(CodePreconditionFailed, "a restic expiry needs a retention in days")
	case p.repo.logical() && len(args.KeepLabels) > 0:
		// keepLabels name pgBackRest labels; the node cannot match them to
		// snapshots, so it cannot promise to keep them.
		return nil, refuse(CodePreconditionFailed, "keepLabels cannot be checked against restic snapshots")
	}
	p.op, p.purpose, p.domain, p.runID = OpBackupExpire, "expire", "backup", args.RunID
	return h.startRun(ctx, job, p)
}

type restoreTarget struct {
	Label    *string `json:"label"`
	Time     *string `json:"time"`
	Lsn      *string `json:"lsn"`
	Timeline *int64  `json:"timeline"`
}

type restoreArgs struct {
	Cluster    clusterRef    `json:"cluster"`
	Repository repositoryRef `json:"repository"`
	RunID      string        `json:"runId"`
	Purpose    string        `json:"purpose"`
	Target     restoreTarget `json:"target"`
	Port       int           `json:"port"`
	Checks     []string      `json:"checks"`
	RowCounts  []rowCount    `json:"rowCounts"`
}

func restoreExecute(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	// One budget for the checks and the start (settleSeconds).
	ctx, cancel := context.WithTimeout(ctx, startBudget)
	defer cancel()
	var args restoreArgs
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	if args.Repository.Engine != "pgbackrest" {
		return nil, refuse(CodePreconditionFailed, "the node restores from pgBackRest repositories only")
	}
	for _, rc := range args.RowCounts {
		if rc.Min > rc.Max {
			return nil, refuse(CodeJobInvalid, "a row count range is empty")
		}
	}
	p, r := h.clusterRun(ctx, args.Cluster, args.Repository)
	if r != nil {
		return nil, r
	}
	for _, b := range []string{"postgres", "pg_ctl"} {
		if r := h.checkBinary(h.postgresBin(p.major) + "/" + b); r != nil {
			return nil, r
		}
	}
	p.op, p.purpose, p.domain, p.runID = OpRestoreExecute, "restore", "restore", args.RunID
	p.newScratch, p.rowCounts, p.port = true, args.RowCounts, args.Port
	return h.startRun(ctx, job, p)
}

func restoreVerify(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	ctx, cancel := context.WithTimeout(ctx, startBudget)
	defer cancel()
	var args struct {
		RunID       string   `json:"runId"`
		VerifyRunID string   `json:"verifyRunId"`
		Port        int      `json:"port"`
		Checks      []string `json:"checks"`
	}
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	if args.RunID == args.VerifyRunID {
		return nil, refuse(CodeJobInvalid, "the verification is its own run")
	}
	runs, r := h.engineDir("runs", false)
	if r != nil {
		return nil, r
	}
	if runs != nil {
		defer runs.Close()
	}
	rec, runDir, r := h.readRecord(runs, args.RunID)
	if r != nil {
		return nil, r
	}
	if runDir != nil {
		defer runDir.Close()
	}
	if rec == nil || rec.Purpose != "restore" || rec.ScratchDirectory == "" {
		return nil, refuse(CodePreconditionFailed, "run %s is not a restore this node ran", args.RunID)
	}
	scratchRoot, r := h.engineDir("scratch", false)
	if r != nil {
		return nil, r
	}
	if scratchRoot == nil {
		return nil, refuse(CodePreconditionFailed, "the scratch directory of run %s is gone", args.RunID)
	}
	defer scratchRoot.Close()
	if info, err := scratchRoot.Lstat(args.RunID); err != nil || info.Kind != fsafe.KindDir || info.UID != rec.EngineUser.UID ||
		scratchRoot.Path()+"/"+args.RunID != rec.ScratchDirectory {
		return nil, refuse(CodePreconditionFailed, "the scratch directory of run %s is gone or not the restore's", args.RunID)
	}
	if r := h.checkBinary(h.postgresBin(rec.PostgresMajor) + "/postgres"); r != nil {
		return nil, r
	}
	return h.startRun(ctx, job, startPlan{
		op: OpRestoreVerify, purpose: "reverify", domain: "restore", runID: args.VerifyRunID, sysid: rec.SystemIdentifier,
		repositoryID: rec.RepositoryID, engine: rec.Engine, user: rec.EngineUser, major: rec.PostgresMajor,
		scratchDir: rec.ScratchDirectory, scratchRunID: args.RunID, rowCounts: rec.RowCounts, port: args.Port,
	})
}

// ----- run.status, run.cancel -----

func runStatus(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	var args struct {
		RunID         string `json:"runId"`
		StartJobID    string `json:"startJobId"`
		StartArgsHash string `json:"startArgsHash"`
	}
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	runs, r := h.engineDir("runs", false)
	if r != nil {
		return nil, r
	}
	if runs != nil {
		defer runs.Close()
	}
	rec, runDir, r := h.readRecord(runs, args.RunID)
	if r != nil {
		return nil, r
	}
	if runDir != nil {
		defer runDir.Close()
	}
	if rec == nil {
		return canon.Object{
			{Name: "runId", Value: canon.String(args.RunID)}, {Name: "found", Value: canon.Bool(false)},
			{Name: "startJobId", Value: canon.Null{}}, {Name: "startArgsHash", Value: canon.Null{}},
			{Name: "purpose", Value: canon.Null{}}, {Name: "state", Value: canon.String("not_found")},
			{Name: "startedAt", Value: canon.Null{}}, {Name: "finishedAt", Value: canon.Null{}},
			{Name: "exitCode", Value: canon.Null{}}, {Name: "progress", Value: canon.Null{}},
			{Name: "excerpt", Value: canon.String("")}, {Name: "outcome", Value: canon.Null{}},
		}, nil
	}
	// The status is bound to the job that started the run (ADR-0037 §1).
	if rec.StartJobID != args.StartJobID || rec.StartArgsHash != args.StartArgsHash {
		return nil, refuse(CodePreconditionFailed, "run %s was started by another job", args.RunID)
	}
	var st unitState
	if res, err := h.readResult(runDir); err != nil || res == nil {
		states, err := h.sup().states(ctx, []string{rec.Unit})
		if err != nil {
			return nil, refuse(CodeFailed, "the state of run %s cannot be read", args.RunID)
		}
		st = states[rec.Unit]
	}
	res := h.collect(rec, runDir, st)
	out := canon.Object{
		{Name: "runId", Value: canon.String(rec.RunID)}, {Name: "found", Value: canon.Bool(true)},
		{Name: "startJobId", Value: canon.String(rec.StartJobID)}, {Name: "startArgsHash", Value: canon.String(rec.StartArgsHash)},
		{Name: "purpose", Value: canon.String(rec.Purpose)},
	}
	get := func(name string) canon.Value {
		v, ok := res.Get(name)
		return nullOr(v, ok)
	}
	out = append(out,
		canon.Member{Name: "state", Value: get("state")},
		canon.Member{Name: "startedAt", Value: canon.String(rec.StartedAt)},
		canon.Member{Name: "finishedAt", Value: get("finishedAt")},
		canon.Member{Name: "exitCode", Value: get("exitCode")},
		canon.Member{Name: "progress", Value: get("progress")},
		canon.Member{Name: "excerpt", Value: get("excerpt")},
		canon.Member{Name: "outcome", Value: get("outcome")},
	)
	if h.Schema.ValidateResult(job.Capability, out) != nil {
		return nil, refuse(CodeFailed, "the state of run %s does not fit the contract", args.RunID)
	}
	return out, nil
}

func runCancel(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	var args struct {
		RunID string `json:"runId"`
	}
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	answer := func(state string) (canon.Object, *Refusal) {
		return canon.Object{{Name: "runId", Value: canon.String(args.RunID)}, {Name: "state", Value: canon.String(state)}}, nil
	}
	runs, r := h.engineDir("runs", false)
	if r != nil {
		return nil, r
	}
	if runs != nil {
		defer runs.Close()
	}
	rec, runDir, r := h.readRecord(runs, args.RunID)
	if r != nil {
		return nil, r
	}
	if runDir != nil {
		defer runDir.Close()
	}
	if rec == nil {
		if r := h.admitEffect(OpRunCancel, job); r != nil {
			return nil, r
		}
		return answer("not_found")
	}
	if res, err := h.readResult(runDir); err == nil && res != nil {
		if r := h.admitEffect(OpRunCancel, job); r != nil {
			return nil, r
		}
		return answer("already_finished")
	}
	states, err := h.sup().states(ctx, []string{rec.Unit})
	if err != nil {
		return nil, refuse(CodeFailed, "the state of run %s cannot be read", args.RunID)
	}
	if !states[rec.Unit].Active {
		if r := h.admitEffect(OpRunCancel, job); r != nil {
			return nil, r
		}
		h.collect(rec, runDir, states[rec.Unit])
		return answer("already_finished")
	}
	if r := h.admitEffect(OpRunCancel, job); r != nil {
		return nil, r
	}
	marker, _ := canon.Canonicalize(canon.Object{{Name: "jobId", Value: canon.String(job.JobID)},
		{Name: "at", Value: canon.String(h.Clock.Now().UTC().Format(time.RFC3339))}})
	_ = runDir.Create("cancel.json", marker, h.rootOwner(0o600))
	// systemd sends SIGTERM to the unit's processes and SIGKILL after its
	// TimeoutStopSec; the engine records canceled only before its effect.
	if err := h.sup().stop(ctx, rec.Unit); err != nil {
		return nil, refuse(CodeFailed, "the unit of run %s could not be stopped", args.RunID)
	}
	return answer("stopping")
}

// ----- restore.discard -----

func restoreDiscard(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	var args struct {
		RunID string `json:"runId"`
	}
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	ctx, cancel := context.WithTimeout(ctx, discardBudget)
	defer cancel()
	answer := func(removed, wasRunning bool) (canon.Object, *Refusal) {
		return canon.Object{{Name: "runId", Value: canon.String(args.RunID)}, {Name: "removed", Value: canon.Bool(removed)},
			{Name: "wasRunning", Value: canon.Bool(wasRunning)}}, nil
	}
	scratchRoot, r := h.engineDir("scratch", false)
	if r != nil {
		return nil, r
	}
	if scratchRoot == nil {
		if r := h.admitEffect(OpRestoreDiscard, job); r != nil {
			return nil, r
		}
		return answer(false, false)
	}
	defer scratchRoot.Close()
	info, err := scratchRoot.Lstat(args.RunID)
	if err != nil {
		return nil, refuse(CodeFailed, "the scratch directory cannot be read")
	}
	if info.Kind == fsafe.KindNone {
		if r := h.admitEffect(OpRestoreDiscard, job); r != nil {
			return nil, r
		}
		return answer(false, false)
	}
	scratchPath := scratchRoot.Path() + "/" + args.RunID
	runs, r := h.engineDir("runs", false)
	if r != nil {
		return nil, r
	}
	if runs != nil {
		defer runs.Close()
	}
	if busy, r := h.activeRuns(ctx, runs, "", "", scratchPath); r != nil {
		return nil, r
	} else if busy {
		return nil, refuse(CodePreconditionFailed, "a run uses the scratch directory of run %s; cancel it first", args.RunID)
	}
	if r := h.admitEffect(OpRestoreDiscard, job); r != nil {
		return nil, r
	}
	wasRunning := false
	if info.Kind == fsafe.KindDir && info.UID != h.rootUID() {
		running, r := h.stopScratch(ctx, scratchRoot, args.RunID, scratchPath, info)
		if r != nil {
			return nil, r
		}
		wasRunning = running
	}
	if _, err := scratchRoot.RemoveAll(ctx, args.RunID); err != nil {
		return nil, refuse(CodeFailed, "the scratch directory of run %s was not removed completely; discard it again", args.RunID)
	}
	return answer(true, wasRunning)
}

// stopScratch stops a scratch cluster that still runs (pg_ctl as the
// directory's owner: fast, then immediate). It reports whether it ran.
func (h *Helper) stopScratch(ctx context.Context, root *fsafe.Dir, runID, path string, info fsafe.Info) (bool, *Refusal) {
	dir, err := root.OpenDir(runID)
	if err != nil {
		return false, refuse(CodeFailed, "the scratch directory cannot be opened")
	}
	defer dir.Close()
	pid, err := dir.Lstat("postmaster.pid")
	if err != nil || pid.Kind != fsafe.KindFile {
		return false, nil
	}
	version, _, err := dir.ReadFile("PG_VERSION", 16)
	major, convErr := strconv.Atoi(strings.TrimSpace(string(version)))
	if err != nil || convErr != nil || major < 16 || major > 18 {
		return false, refuse(CodePreconditionFailed, "the scratch cluster's major cannot be read; nothing was removed")
	}
	pgCtl := h.path(h.postgresBin(major)) + "/pg_ctl"
	if r := h.checkBinary(h.postgresBin(major) + "/pg_ctl"); r != nil {
		return false, r
	}
	ctl := func(args ...string) (int, error) {
		out, err := h.sup().runAs(ctx, execSpec{UID: info.UID, GID: info.GID, Path: pgCtl, Args: args, Timeout: 2 * time.Minute})
		return out.ExitCode, err
	}
	// pg_ctl status: 0 running, 3 not running.
	code, err := ctl("status", "-D", path)
	if err != nil {
		return false, refuse(CodeFailed, "the scratch cluster's state cannot be read; nothing was removed")
	}
	if code != 0 {
		return false, nil
	}
	if code, err = ctl("stop", "-D", path, "-m", "fast", "-w", "-t", "60"); err != nil || code != 0 {
		_, _ = ctl("stop", "-D", path, "-m", "immediate", "-w", "-t", "30")
	}
	if code, err = ctl("status", "-D", path); err != nil || code == 0 {
		return true, refuse(CodeFailed, "the scratch cluster could not be stopped; nothing was removed")
	}
	return true, nil
}

// ----- restore.prepare -----

func restorePrepare(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	var args restoreArgs
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	ctx, cancel := context.WithTimeout(ctx, startBudget)
	defer cancel()
	in, r := h.instance(args.Cluster)
	if r != nil {
		return nil, r
	}
	var refusals []string
	add := func(s string) {
		for _, x := range refusals {
			if x == s {
				return
			}
		}
		refusals = append(refusals, s)
	}
	enginePath := h.path(h.paths().Engine)
	available, err := spaceAvailable(enginePath)
	if err != nil {
		return nil, refuse(CodeNotConfigured, "the engine directory is missing")
	}
	scratchFree := true
	scratchRoot, r := h.engineDir("scratch", false)
	if r != nil {
		return nil, r
	}
	scratchPath := enginePath + "/scratch/" + args.RunID
	if scratchRoot != nil {
		if info, err := scratchRoot.Lstat(args.RunID); err != nil || info.Kind != fsafe.KindNone {
			scratchFree = false
			add("scratch_exists")
		}
		scratchRoot.Close()
	}
	if h.scratchOverlaps(scratchPath) {
		return nil, refuse(CodePreconditionFailed, "the scratch directory overlaps a data, WAL or tablespace directory")
	}
	port := canon.Value(canon.Null{})
	for p := 55400; p <= 55499; p++ {
		listening, err := h.portListening(p)
		if err != nil {
			return nil, refuse(CodeFailed, "the host's listening ports cannot be read")
		}
		if !listening {
			port = canon.Number(p)
			break
		}
	}
	if _, isNull := port.(canon.Null); isNull {
		add("no_free_port")
	}
	required := canon.Value(canon.Null{})
	engineCanRead := false
	walContinuous := canon.Value(canon.Null{})
	stanza, r := h.prepareInfo(ctx, in.DataDirectory, args)
	switch {
	case r != nil && r.Code == "repository_not_configured":
		add("repository_not_configured")
	case r != nil:
		add("engine_cannot_read")
	case stanza.systemID() != args.Cluster.SystemIdentifier:
		add("system_identifier_mismatch")
	default:
		engineCanRead = true
		chosen, outside := chooseBackup(stanza, args.Target)
		switch {
		case args.Target.Label != nil && chosen == nil:
			add("label_not_found")
		case chosen == nil || outside:
			add("target_outside_window")
			walContinuous = canon.Bool(false)
		}
		if len(stanza.Archive) == 0 {
			walContinuous = canon.Bool(false)
		}
		if chosen != nil && chosen.Info.Size != nil && *chosen.Info.Size >= 0 {
			required = canon.Number(*chosen.Info.Size)
			if available < *chosen.Info.Size+*chosen.Info.Size/10 {
				add("space_insufficient")
			}
		}
	}
	list := canon.Array{}
	for _, s := range refusals {
		list = append(list, canon.String(s))
	}
	return canon.Object{
		{Name: "runId", Value: canon.String(args.RunID)},
		{Name: "scratchFree", Value: canon.Bool(scratchFree)},
		{Name: "port", Value: port},
		{Name: "spaceAvailableBytes", Value: canon.Number(available)},
		{Name: "spaceRequiredBytes", Value: required},
		{Name: "engineCanRead", Value: canon.Bool(engineCanRead)},
		{Name: "walContinuous", Value: walContinuous},
		{Name: "refusals", Value: list},
	}, nil
}

// prepareInfo reads the stanza's catalog for a restore plan.
func (h *Helper) prepareInfo(ctx context.Context, dataDirectory string, args restoreArgs) (*pgbrStanza, *Refusal) {
	if args.Repository.Engine != "pgbackrest" {
		return nil, refuse("engine_cannot_read", "")
	}
	in, _ := h.Config.Instance(args.Cluster.LocalName)
	owner, r := h.dataOwner(in)
	if r != nil {
		return nil, r
	}
	u, r := h.engineUser(owner.UID, owner.GID)
	if r != nil {
		return nil, r
	}
	repo, r := h.resolveRepository(args.Repository, u.UID)
	if r != nil {
		return nil, refuse("repository_not_configured", "")
	}
	return h.pgbrInfo(ctx, repo, u)
}

// chooseBackup picks the backup a restore to target starts from: the
// labelled one, else the newest good backup that ended before the target.
// outside: the target lies before the chosen backup's end.
func chooseBackup(s *pgbrStanza, t restoreTarget) (*pgbrBackup, bool) {
	var targetTime time.Time
	if t.Time != nil {
		targetTime, _ = time.Parse(time.RFC3339Nano, *t.Time)
	}
	targetLsn, hasLsn := uint64(0), false
	if t.Lsn != nil {
		targetLsn, hasLsn = parseLsn(*t.Lsn)
	}
	before := func(b *pgbrBackup) bool {
		switch {
		case t.Time != nil:
			return b.Timestamp.Stop > 0 && !time.Unix(b.Timestamp.Stop, 0).After(targetTime)
		case hasLsn:
			stop, ok := parseLsn(strOr(b.LSN.Stop))
			return ok && stop <= targetLsn
		}
		return true
	}
	if t.Label != nil {
		for i := range s.Backup {
			if s.Backup[i].Label == *t.Label {
				return &s.Backup[i], !before(&s.Backup[i])
			}
		}
		return nil, false
	}
	for i := len(s.Backup) - 1; i >= 0; i-- {
		b := &s.Backup[i]
		if (b.Error == nil || !*b.Error) && before(b) {
			return b, false
		}
	}
	return nil, true
}

func strOr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func parseLsn(s string) (uint64, bool) {
	hi, lo, ok := strings.Cut(strings.ToUpper(s), "/")
	if !ok || !lsnRE.MatchString(strings.ToUpper(s)) {
		return 0, false
	}
	a, err1 := strconv.ParseUint(hi, 16, 32)
	b, err2 := strconv.ParseUint(lo, 16, 32)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	return a<<32 | b, true
}

// ----- backup.list -----

func includeOf(h *Helper, repo *repository) string {
	if repo.pgbrInclude == "" {
		return ""
	}
	return h.path(repo.pgbrInclude)
}

// pgbrBase names the configuration exactly as the helper read it: the
// file, and the conf.d directory it merged.
func pgbrBase(config, include, stanza string, repo int) []string {
	args := []string{"--config=" + config}
	if include != "" {
		args = append(args, "--config-include-path="+include)
	}
	return append(args, "--stanza="+stanza, "--repo="+strconv.Itoa(repo))
}

// pgbrInfoArgs is the fixed argv of pgBackRest's catalog read.
func pgbrInfoArgs(config, include, stanza string, repo int, set string) []string {
	args := append(pgbrBase(config, include, stanza, repo), "--output=json", "--log-level-console=off", "--log-level-stderr=off")
	if set != "" {
		args = append(args, "--set="+set)
	}
	return append(args, "info")
}

func (h *Helper) pgbrInfo(ctx context.Context, repo *repository, u engineUser) (*pgbrStanza, *Refusal) {
	optional, bind := pgbrWritable(repo.pgbrPaths)
	out, err := h.sup().runAs(ctx, execSpec{UID: u.UID, GID: u.GID, Path: PgBackRest,
		Args: pgbrInfoArgs(h.path(repo.pgbrConfig), includeOf(h, repo), repo.stanza(), repo.repoIndex(), ""), Optional: optional, Bind: bind, Timeout: 30 * time.Second})
	if err != nil || out.ExitCode != 0 {
		return nil, refuse(CodeFailed, "pgBackRest could not read the repository")
	}
	s, err := parsePgbrInfo(out.Stdout, repo.stanza())
	if err != nil {
		return nil, refuse(CodeFailed, "pgBackRest's catalog is not readable")
	}
	return s, nil
}

func backupList(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal) {
	var args struct {
		Cluster    clusterRef    `json:"cluster"`
		Repository repositoryRef `json:"repository"`
	}
	if r := decodeArgs(job, &args); r != nil {
		return nil, r
	}
	ctx, cancel := context.WithTimeout(ctx, startBudget)
	defer cancel()
	in, r := h.instance(args.Cluster)
	if r != nil {
		return nil, r
	}
	owner, r := h.dataOwner(in)
	if r != nil {
		return nil, r
	}
	u, r := h.engineUser(owner.UID, owner.GID)
	if r != nil {
		return nil, r
	}
	repo, r := h.resolveRepository(args.Repository, u.UID)
	if r != nil {
		return nil, r
	}
	binary := PgBackRest
	if repo.logical() {
		binary = Restic
	}
	if r := h.checkBinary(binary); r != nil {
		return nil, r
	}
	// The version command reads no repository; it runs as root.
	version := ""
	if out, err := h.Runner.Run(ctx, Command{Path: binary, Args: []string{"version"}, Timeout: 10 * time.Second}); err == nil && out.ExitCode == 0 {
		version = engineVersion(out.Stdout)
	}
	if !repo.logical() {
		s, r := h.pgbrInfo(ctx, repo, u)
		if r != nil {
			return nil, r
		}
		return pgbrListResult(s, version), nil
	}
	out, r := h.resticRead(ctx, repo, u, []string{"snapshots", "--json", "--no-lock", "--no-cache", "--tag", "exponetdb"})
	if r != nil {
		return nil, r
	}
	result, err := resticListResult(out, version)
	if err != nil {
		return nil, refuse(CodeFailed, "restic's snapshot list is not readable")
	}
	return result, nil
}

// resticRead runs a restic read as the engine user with the repository's
// files copied into a private directory that is removed afterwards.
func (h *Helper) resticRead(ctx context.Context, repo *repository, u engineUser, args []string) ([]byte, *Refusal) {
	reads, r := h.engineDir("reads", true)
	if r != nil {
		return nil, r
	}
	defer reads.Close()
	name := "read-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	if err := reads.Mkdir(name, h.rootOwner(0o711)); err != nil {
		return nil, refuse(CodeFailed, "a private directory for the read could not be created")
	}
	defer func() { _, _ = reads.RemoveAll(context.Background(), name) }()
	dir, err := reads.OpenDir(name)
	if err != nil {
		return nil, refuse(CodeFailed, "a private directory for the read could not be opened")
	}
	defer dir.Close()
	private, err := h.privateDir(dir)
	if err != nil {
		return nil, refuse(CodeFailed, "a private directory for the read could not be created")
	}
	defer private.Close()
	env, err := h.resticSecretsIn(dir, reads.Path()+"/"+name, private, reads.Path()+"/"+name+"/private", repo, u)
	if err != nil {
		return nil, refuse(CodeFailed, "the repository files could not be prepared")
	}
	out, err := h.sup().runAs(ctx, execSpec{UID: u.UID, GID: u.GID, Path: Restic, Args: args, EnvironmentFile: env, Timeout: 50 * time.Second})
	if err != nil || out.ExitCode != 0 {
		return nil, refuse(CodeFailed, "restic could not read the repository")
	}
	return out.Stdout, nil
}

// ----- backup.timers -----

var backupUnitRE = []string{"pgbackrest", "restic", "backup"}

func backupNamed(s string) bool {
	l := strings.ToLower(s)
	for _, k := range backupUnitRE {
		if strings.Contains(l, k) {
			return true
		}
	}
	return false
}

func showTime(v string) canon.Value {
	v = strings.TrimPrefix(v, "@")
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return canon.Null{}
	}
	return canon.String(time.Unix(n, 0).UTC().Format(time.RFC3339))
}

func backupTimers(ctx context.Context, h *Helper, _ *verify.Job) (canon.Object, *Refusal) {
	ctx, cancel := context.WithTimeout(ctx, startBudget)
	defer cancel()
	out, err := h.Runner.Run(ctx, Command{Path: Systemctl, Args: []string{"list-units", "--type=timer", "--all", "--plain", "--no-legend", "--no-pager", "--full"}})
	if err != nil || out.ExitCode != 0 {
		return nil, refuse(CodeFailed, "systemctl list-units failed")
	}
	var timers []string
	for _, line := range strings.Split(string(out.Stdout), "\n") {
		f := strings.Fields(line)
		if len(f) > 0 && strings.HasSuffix(f[0], ".timer") && unitNameRE.MatchString(f[0]) && len(timers) < 512 {
			timers = append(timers, f[0])
		}
	}
	list := canon.Array{}
	if len(timers) == 0 {
		return canon.Object{{Name: "timers", Value: list}}, nil
	}
	out, err = h.Runner.Run(ctx, Command{Path: Systemctl, Args: append([]string{"show", "--timestamp=unix",
		"--property=Id,Unit,NextElapseUSecRealtime,LastTriggerUSec", "--"}, timers...)})
	if err != nil || out.ExitCode != 0 {
		return nil, refuse(CodeFailed, "systemctl show failed")
	}
	blocks := parseShow(out.Stdout)
	type timer struct{ unit, activates, next, last string }
	var found []timer
	sort.Strings(timers)
	for _, t := range timers {
		b := blocks[t]
		if b == nil || !unitNameRE.MatchString(b["Unit"]) {
			continue
		}
		if (backupNamed(t) || backupNamed(b["Unit"])) && len(found) < 64 {
			found = append(found, timer{t, b["Unit"], b["NextElapseUSecRealtime"], b["LastTriggerUSec"]})
		}
	}
	results := map[string]string{}
	if len(found) > 0 {
		args := []string{"show", "--property=Id,Result", "--"}
		for _, f := range found {
			args = append(args, f.activates)
		}
		if out, err := h.Runner.Run(ctx, Command{Path: Systemctl, Args: args}); err == nil && out.ExitCode == 0 {
			for id, b := range parseShow(out.Stdout) {
				results[id] = b["Result"]
			}
		}
	}
	for _, f := range found {
		last := showTime(f.last)
		result := canon.Value(canon.Null{})
		if _, never := last.(canon.Null); !never && results[f.activates] != "" {
			result = canon.String(bounded(results[f.activates], 64))
		}
		list = append(list, canon.Object{
			{Name: "unit", Value: canon.String(bounded(f.unit, 256))},
			{Name: "activates", Value: canon.String(bounded(f.activates, 256))},
			{Name: "nextAt", Value: showTime(f.next)},
			{Name: "lastAt", Value: last},
			{Name: "lastResult", Value: result},
		})
	}
	return canon.Object{{Name: "timers", Value: list}}, nil
}

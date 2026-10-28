package helper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsafe"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
)

// engine-run (ADR-0037 §2): the program a run's transient unit executes as
// the engine user. It reads the root-written run record, validates it and
// its arguments against the contract again, builds each engine's argv from
// them (fixed templates, no shell), runs the engines, and writes its outcome
// (work/outcome.json) and progress (work/progress.json) for the helper,
// which reads both as untrusted data. Secrets reach the engines as files in
// work/secrets (removed at the end), never as arguments.

// EngineOptions configure one engine run.
type EngineOptions struct {
	// RunsRoot is <engine>/runs (DefaultPaths in production).
	RunsRoot string
	RunID    string
	// RecordOwner is the uid the record must belong to (0: root).
	RecordOwner int

	exec       engineExec
	now        func() time.Time
	skipChecks bool
}

// engineCmd is one engine execution.
type engineCmd struct {
	Path string
	Args []string
	Env  []string
	Out  io.Writer
}

type engineProc interface {
	signal(sig syscall.Signal) error
	wait() (int, error)
	exited() <-chan struct{}
}

type engineExec interface {
	run(ctx context.Context, c engineCmd) (int, error)
	start(c engineCmd) (engineProc, error)
}

// osExec runs engines as children of engine-run, without a shell, with a
// fixed environment, no standard input and the root as working directory.
type osExec struct{}

func command(ctx context.Context, c engineCmd) *exec.Cmd {
	var cmd *exec.Cmd
	if ctx != nil {
		cmd = exec.CommandContext(ctx, c.Path, c.Args...)
		cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
		cmd.WaitDelay = engineGrace - 15*time.Second
	} else {
		cmd = exec.Command(c.Path, c.Args...)
	}
	cmd.Env = append([]string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C", "LANG=C"}, c.Env...)
	cmd.Dir = "/"
	out := c.Out
	if out == nil {
		out = io.Discard
	}
	cmd.Stdout, cmd.Stderr = out, out
	return cmd
}

func (osExec) run(ctx context.Context, c engineCmd) (int, error) {
	cmd := command(ctx, c)
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

type osProc struct {
	cmd  *exec.Cmd
	done chan struct{}
	code int
	err  error
}

func (osExec) start(c engineCmd) (engineProc, error) {
	cmd := command(nil, c)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &osProc{cmd: cmd, done: make(chan struct{})}
	go func() {
		err := cmd.Wait()
		var exit *exec.ExitError
		switch {
		case errors.As(err, &exit):
			p.code = exit.ExitCode()
		case err != nil:
			p.code, p.err = -1, err
		}
		close(p.done)
	}()
	return p, nil
}

func (p *osProc) signal(sig syscall.Signal) error { return p.cmd.Process.Signal(sig) }
func (p *osProc) wait() (int, error)              { <-p.done; return p.code, p.err }
func (p *osProc) exited() <-chan struct{}         { return p.done }

// lockedWriter serializes writes of an engine's two output streams.
type lockedWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// lineWriter calls fn for each complete line and keeps the output's tail.
type lineWriter struct {
	mu   sync.Mutex
	tail *tail
	part []byte
	fn   func(string)
}

func (l *lineWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.tail.Write(p)
	l.part = append(l.part, p...)
	for {
		i := strings.IndexByte(string(l.part), '\n')
		if i < 0 {
			break
		}
		if l.fn != nil {
			l.fn(string(l.part[:i]))
		}
		l.part = l.part[i+1:]
	}
	if len(l.part) > 64*1024 {
		l.part = l.part[len(l.part)-64*1024:]
	}
	return len(p), nil
}

// engineRun is the state of one run while engine-run executes it.
type engineRun struct {
	o       EngineOptions
	rec     *runRecord
	args    canon.Object
	work    *fsafe.Dir
	out     *tail
	outcome runOutcome
	// effect: the engine began changing a repository or a scratch directory;
	// a stop after it is reported failed, never canceled (ADR-0037 §4).
	effect bool
}

func (e *engineRun) now() string { return e.o.now().UTC().Format(time.RFC3339Nano) }

// EngineRun executes the run named in o (the engine-run subcommand). It
// returns an error only when no outcome could be written; the run's own
// failure is its outcome.
func EngineRun(ctx context.Context, o EngineOptions) error {
	if o.exec == nil {
		o.exec = osExec{}
	}
	if o.now == nil {
		o.now = time.Now
	}
	if !runIDRE.MatchString(o.RunID) {
		return errors.New("engine-run: not a run id")
	}
	runs, err := fsafe.OpenDirSearch(o.RunsRoot)
	if err != nil {
		return fmt.Errorf("engine-run: the runs directory: %w", err)
	}
	defer runs.Close()
	runDir, err := runs.OpenDir(o.RunID)
	if err != nil {
		return fmt.Errorf("engine-run: the run directory: %w", err)
	}
	defer runDir.Close()
	if owner, err := runDir.Owner(); err != nil || owner.UID != o.RecordOwner || owner.Mode&0o022 != 0 {
		return errors.New("engine-run: the run directory is not root's")
	}
	data, st, err := runDir.ReadFile("record.json", 1<<20)
	if err != nil || st.UID != o.RecordOwner || st.Mode&0o022 != 0 {
		return errors.New("engine-run: the run record cannot be read safely")
	}
	var rec runRecord
	if err := decodeStrict(data, &rec); err != nil || rec.validate() != nil || rec.RunID != o.RunID {
		return errors.New("engine-run: the run record is invalid")
	}
	if !o.skipChecks && os.Geteuid() != rec.EngineUser.UID {
		return errors.New("engine-run: not running as the run's engine user")
	}
	if rec.WorkDirectory != o.RunsRoot+"/"+o.RunID+"/work" {
		return errors.New("engine-run: the work directory is not the run's")
	}
	work, err := runDir.OpenDir("work")
	if err != nil {
		return errors.New("engine-run: the work directory cannot be opened")
	}
	defer work.Close()
	e := &engineRun{o: o, rec: &rec, work: work, out: &tail{n: 32 * 1024},
		outcome: runOutcome{Schema: OutcomeSchema, State: "failed", Checks: []checkItem{}, Phases: []phaseItem{}}}
	defer func() { _, _ = work.RemoveAll(context.Background(), "secrets") }()
	if msg := e.validate(); msg != "" {
		e.outcome.Excerpt = msg
		return e.finish(ctx)
	}
	e.dispatch(ctx)
	return e.finish(ctx)
}

// validate checks the record's arguments against the contract and its paths
// and binaries against their fixed places.
func (e *engineRun) validate() string {
	sv, err := schema.Protocol()
	if err != nil {
		return "the protocol schema is not available"
	}
	v, err := canon.Parse(e.rec.Args)
	args, ok := v.(canon.Object)
	if err != nil || !ok || sv.ValidateArgs(e.rec.Capability, args) != nil {
		return "the run's arguments do not fit " + e.rec.Capability
	}
	e.args = args
	want := map[string]string{"backup.run@1": "backup", "backup.verify@1": "verify", "backup.expire@1": "expire",
		"restore.execute@1": "restore", "restore.verify@1": "reverify"}[e.rec.Capability]
	if want != e.rec.Purpose {
		return "the run's purpose does not fit its capability"
	}
	if id, _ := args.Get("runId"); e.rec.Purpose != "reverify" && id != canon.String(e.rec.RunID) {
		return "the run's arguments name another run"
	}
	if id, _ := args.Get("verifyRunId"); e.rec.Purpose == "reverify" && id != canon.String(e.rec.RunID) {
		return "the run's arguments name another run"
	}
	scratchRoot := filepath.Dir(e.o.RunsRoot) + "/scratch/"
	switch e.rec.Purpose {
	case "restore":
		if e.rec.ScratchDirectory != scratchRoot+e.rec.RunID {
			return "the scratch directory is not the run's"
		}
	case "reverify":
		if !runIDRE.MatchString(e.rec.ScratchRunID) || e.rec.ScratchDirectory != scratchRoot+e.rec.ScratchRunID {
			return "the scratch directory is not the restore's"
		}
	default:
		if e.rec.ScratchDirectory != "" {
			return "the run has no scratch directory"
		}
	}
	if p := e.rec.PgBackRest; p != nil && (!stanzaRE.MatchString(p.Stanza) || p.Repo < 1 || p.Repo > 4 ||
		(p.Include != "" && p.Include != filepath.Dir(p.Config)+"/conf.d")) {
		return "the run's pgBackRest configuration is not the helper's"
	}
	if m := postgresBinRE.FindStringSubmatch(e.rec.PostgresBin + "/postgres"); m == nil || m[1] != strconv.Itoa(e.rec.PostgresMajor) {
		return "the PostgreSQL binaries are not the run's major"
	}
	return ""
}

// binary checks an engine binary before it runs (root-owned, writable by
// root only, no symlink on its path).
func (e *engineRun) binary(path string) error {
	if !engineBinary(path) {
		return errors.New("the binary is not allowlisted")
	}
	if e.o.skipChecks {
		return nil
	}
	dirPath, name, err := fsafe.Split(path)
	if err != nil {
		return err
	}
	dir, err := fsafe.OpenDir(dirPath)
	if err != nil {
		return err
	}
	defer dir.Close()
	info, err := dir.Lstat(name)
	if err != nil || info.Kind != fsafe.KindFile || info.UID != 0 || info.Mode&0o022 != 0 {
		return errors.New("the binary is not installed safely")
	}
	return nil
}

// exec runs one engine; its output goes to the run's excerpt (and to fn per
// line).
func (e *engineRun) exec(ctx context.Context, path string, args []string, env []string, fn func(string)) (int, error) {
	if err := e.binary(path); err != nil {
		e.note("%s: %v", filepath.Base(path), err)
		return -1, err
	}
	return e.o.exec.run(ctx, engineCmd{Path: path, Args: args, Env: env, Out: &lineWriter{tail: e.out, fn: fn}})
}

// execQuiet runs an engine whose output names database objects (pg_restore
// --list): it never reaches an excerpt.
func (e *engineRun) execQuiet(ctx context.Context, path string, args []string) (int, error) {
	if err := e.binary(path); err != nil {
		e.note("%s: %v", filepath.Base(path), err)
		return -1, err
	}
	return e.o.exec.run(ctx, engineCmd{Path: path, Args: args, Out: io.Discard})
}

func (e *engineRun) note(format string, args ...any) {
	_, _ = e.out.Write([]byte(fmt.Sprintf(format, args...) + "\n"))
}

func (e *engineRun) finish(ctx context.Context) error {
	if ctx.Err() != nil {
		if e.effect {
			e.outcome.State = "failed"
			e.note("stopped on a cancel request after the engine began its effect")
		} else {
			e.outcome.State = "canceled"
			e.note("stopped on a cancel request before the engine began its effect")
		}
	}
	e.outcome.FinishedAt = e.now()
	if e.outcome.Excerpt == "" {
		e.outcome.Excerpt = Redact(e.out.String(), 2048)
	} else {
		e.outcome.Excerpt = Redact(e.out.String()+"\n"+e.outcome.Excerpt, 2048)
	}
	data, err := json.Marshal(e.outcome)
	if err != nil {
		return err
	}
	return e.writeWork("outcome.json", data)
}

// writeWork writes a file of the work directory atomically (0600).
func (e *engineRun) writeWork(name string, data []byte) error {
	o := fsafe.Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o600}
	return e.work.Install(name, data, o)
}

func (e *engineRun) progress(percent *float64, bytes *int64) {
	data, _ := json.Marshal(runProgress{Percent: percent, Bytes: bytes})
	_ = e.writeWork("progress.json", data)
}

func (e *engineRun) str(name string) string {
	v, _ := e.args.Get(name)
	s, _ := v.(canon.String)
	return string(s)
}

func (e *engineRun) dispatch(ctx context.Context) {
	logical := e.rec.Engine == "restic" || e.rec.Engine == "pg_dump"
	switch {
	case e.rec.Purpose == "backup" && logical:
		e.logicalBackup(ctx)
	case e.rec.Purpose == "backup":
		e.pgbrBackup(ctx)
	case e.rec.Purpose == "verify" && logical:
		e.resticCheck(ctx)
	case e.rec.Purpose == "verify":
		e.pgbrVerify(ctx)
	case e.rec.Purpose == "expire" && logical:
		e.resticForget(ctx)
	case e.rec.Purpose == "expire":
		e.pgbrExpire(ctx)
	case e.rec.Purpose == "restore":
		e.restore(ctx)
	case e.rec.Purpose == "reverify":
		e.reverify(ctx)
	}
}

func (e *engineRun) finishExit(code int, err error) {
	if err == nil {
		c := code
		e.outcome.ExitCode = &c
	}
	if err == nil && code == 0 {
		e.outcome.State = "succeeded"
	}
}

// ----- pgBackRest -----

func (e *engineRun) pgbr(args ...string) []string {
	p := e.rec.PgBackRest
	return append(pgbrBase(p.Config, p.Include, p.Stanza, p.Repo), args...)
}

var newLabelRE = regexp.MustCompile(`new backup label = ([0-9]{8}-[0-9]{6}F(?:_[0-9]{8}-[0-9]{6}[DI])?)`)

func (e *engineRun) pgbrBackup(ctx context.Context) {
	if e.rec.PgBackRest == nil {
		e.note("the run has no pgBackRest repository")
		return
	}
	kind := map[string]string{"full": "full", "differential": "diff", "incremental": "incr"}[e.str("kind")]
	if kind == "" {
		e.note("the backup kind is not a pgBackRest kind")
		return
	}
	if _, ok := e.ownStanza(ctx); !ok {
		return
	}
	var label string
	e.effect = true
	code, err := e.exec(ctx, PgBackRest, e.pgbr("--no-expire-auto", "--type="+kind, "--log-level-console=info", "backup"), nil, func(line string) {
		if m := newLabelRE.FindStringSubmatch(line); m != nil {
			label = m[1]
		}
	})
	e.finishExit(code, err)
	if label != "" {
		e.outcome.Label = &label
	}
}

func (e *engineRun) pgbrVerify(ctx context.Context) {
	if e.rec.PgBackRest == nil {
		e.note("the run has no pgBackRest repository")
		return
	}
	if _, ok := e.ownStanza(ctx); !ok {
		return
	}
	args := []string{"--log-level-console=info", "--output=text"}
	if set := e.str("label"); set != "" {
		args = append(args, "--set="+set)
	}
	scan := &verifyScan{}
	code, err := e.exec(ctx, PgBackRest, e.pgbr(append(args, "verify")...), nil, scan.line)
	e.finishExit(code, err)
	if err == nil && code == 0 {
		// pgbackrest verify exits 0 when it reports a corrupt or missing file (TC-011, D-03): the
		// result is in its text, and a backup is not verified on a corrupt archive.
		n := scan.errors()
		e.outcome.VerifyErrors = &n
		if n > 0 {
			e.outcome.State = "failed"
			e.note("pgbackrest verify reported %d error(s) in the repository", n)
		}
	}
}

// verifyCountsRE is the line pgBackRest prints under each archive and backup it verified.
var verifyCountsRE = regexp.MustCompile(`^\s*missing:\s*(\d+),\s*checksum invalid:\s*(\d+),\s*size invalid:\s*(\d+),\s*other:\s*(\d+)\s*$`)

// verifyFlaggedRE is what marks a bad result without a count: an error or invalid status of the
// stanza or a backup, and the warning for a file that did not verify.
var verifyFlaggedRE = regexp.MustCompile(`(?i)^\s*status:\s*(?:error|invalid)\b|,\s*status:\s*(?:error|invalid)\b|invalid result`)

// verifyScan reads pgbackrest verify's text: the files it counted as missing or invalid, or, when
// it counted none, the lines that say a result was bad (at least one error then).
type verifyScan struct {
	counted int64
	flagged int64
}

func (v *verifyScan) line(l string) {
	if m := verifyCountsRE.FindStringSubmatch(l); m != nil {
		for _, field := range m[1:] {
			n, err := strconv.ParseInt(field, 10, 64)
			if err == nil && n > 0 {
				v.counted += n
			}
		}
		return
	}
	if verifyFlaggedRE.MatchString(l) {
		v.flagged++
	}
}

func (v *verifyScan) errors() int64 {
	if v.counted > 0 {
		return v.counted
	}
	return v.flagged
}

func (e *engineRun) pgbrInfo(ctx context.Context) (*pgbrStanza, bool) {
	p := e.rec.PgBackRest
	var buf strings.Builder
	w := &lockedWriter{w: &buf}
	if err := e.binary(PgBackRest); err != nil {
		e.note("pgbackrest: %v", err)
		return nil, false
	}
	code, err := e.o.exec.run(ctx, engineCmd{Path: PgBackRest, Args: pgbrInfoArgs(p.Config, p.Include, p.Stanza, p.Repo, ""), Out: w})
	if err != nil || code != 0 {
		e.note("pgBackRest could not read the repository (exit %d)", code)
		return nil, false
	}
	s, err := parsePgbrInfo([]byte(buf.String()), p.Stanza)
	if err != nil {
		e.note("pgBackRest's catalog is not readable")
		return nil, false
	}
	return s, true
}

func (e *engineRun) pgbrExpire(ctx context.Context) {
	if e.rec.PgBackRest == nil {
		e.note("the run has no pgBackRest repository")
		return
	}
	ret, _ := e.args.Get("retention")
	retention, _ := ret.(canon.Object)
	count := func(name string) *int {
		v, _ := retention.Get(name)
		n, ok := v.(canon.Number)
		if !ok {
			return nil
		}
		i := int(n)
		return &i
	}
	full, diff := count("fullCount"), count("differentialCount")
	if full == nil || *full < 1 {
		e.note("refused: an expiry needs a full retention count")
		return
	}
	// First the catalog: the expiry is refused unless every kept label
	// certainly survives the retention (ADR-0036; capabilities.md §1).
	s, ok := e.ownStanza(ctx)
	if !ok {
		return
	}
	survivors := pgbrSurvivors(s, *full, diff)
	keep, _ := e.args.Get("keepLabels")
	var kept []string
	for _, v := range keep.(canon.Array) {
		label := string(v.(canon.String))
		kept = append(kept, label)
		if !survivors[label] {
			e.note("refused: the retention would remove, or cannot be shown to keep, backup %s", label)
			return
		}
	}
	n := strconv.Itoa(e.rec.PgBackRest.Repo)
	args := []string{"--repo" + n + "-retention-full-type=count", "--repo" + n + "-retention-full=" + strconv.Itoa(*full)}
	if diff != nil {
		args = append(args, "--repo"+n+"-retention-diff="+strconv.Itoa(*diff))
	}
	// Then the engine's own decision, without changing anything (review
	// finding B-3): `expire --dry-run` lists what it would remove; a kept
	// label among it refuses the expiry.
	var planned []string
	code, err := e.exec(ctx, PgBackRest, e.pgbr(append(append([]string{}, args...), "--dry-run", "--log-level-console=info", "expire")...), nil, func(line string) {
		if expireLineRE.MatchString(line) {
			planned = append(planned, labelTokenRE.FindAllString(line, -1)...)
		}
	})
	if err != nil || code != 0 {
		e.note("refused: pgBackRest's dry run of the expiry failed (exit %d)", code)
		return
	}
	for _, label := range kept {
		for _, p := range planned {
			if p == label {
				e.note("refused: pgBackRest would expire kept backup %s", label)
				return
			}
		}
	}
	e.effect = true
	code, err = e.exec(ctx, PgBackRest, e.pgbr(append(args, "--log-level-console=info", "expire")...), nil, nil)
	e.finishExit(code, err)
	// A backup that ended between the checks and the expiry can still push a
	// kept backup out (the node cannot hold pgBackRest's lock across two
	// commands): the catalog is read again, and a kept label that is gone
	// makes the run failed, whatever the engine's exit.
	after, ok := e.pgbrInfo(context.WithoutCancel(ctx))
	if !ok {
		e.outcome.State = "failed"
		e.note("the catalog could not be read after the expiry; the kept backups are not confirmed")
		return
	}
	present := map[string]bool{}
	for _, b := range after.Backup {
		present[b.Label] = true
	}
	for _, label := range kept {
		if !present[label] {
			e.outcome.State = "failed"
			e.note("kept backup %s is gone after the expiry (a backup that completed meanwhile can shift the retention); a person reconciles", label)
		}
	}
}

var (
	expireLineRE = regexp.MustCompile(`expire (full|diff|incr)[a-z ]* backup|remove expired backup`)
	labelTokenRE = regexp.MustCompile(`[0-9]{8}-[0-9]{6}F(?:_[0-9]{8}-[0-9]{6}[DI])?`)
)

// ownStanza reads the stanza's catalog and refuses a run whose stanza is
// another cluster's (review finding B-2), right before the engine runs.
func (e *engineRun) ownStanza(ctx context.Context) (*pgbrStanza, bool) {
	s, ok := e.pgbrInfo(ctx)
	if !ok {
		return nil, false
	}
	if id := s.systemID(); id == "" || id != e.rec.SystemIdentifier {
		e.note("refused: the stanza belongs to another cluster (system identifier mismatch)")
		return nil, false
	}
	return s, true
}

// ----- restic and pg_dump -----

// resticEnv is restic's environment: the allowlisted credentials systemd
// placed in engine-run's environment from the root-only environment file,
// and the run's own repository and password files.
func (e *engineRun) resticEnv() []string {
	sec := e.rec.WorkDirectory + "/secrets"
	env := []string{"HOME=" + e.rec.WorkDirectory, "RESTIC_REPOSITORY_FILE=" + sec + "/repository", "RESTIC_PASSWORD_FILE=" + sec + "/password"}
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if resticEnvironment[k] {
			env = append(env, kv)
		}
	}
	return env
}

type resticMessage struct {
	MessageType string   `json:"message_type"`
	PercentDone *float64 `json:"percent_done"`
	BytesDone   *int64   `json:"bytes_done"`
	SnapshotID  string   `json:"snapshot_id"`
}

func (e *engineRun) logicalBackup(ctx context.Context) {
	inst := e.rec.Instance
	if inst == nil {
		e.note("the run names no instance")
		return
	}
	dbs, _ := e.args.Get("databases")
	if err := e.work.Mkdir("dump", fsafe.Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o700}); err != nil {
		e.note("the dump directory could not be created")
		return
	}
	dumpDir := e.rec.WorkDirectory + "/dump"
	defer func() { _, _ = e.work.RemoveAll(context.Background(), "dump") }()
	conn := []string{"--host=" + inst.SocketDirectory, "--port=" + strconv.Itoa(inst.Port), "--no-password"}
	bin := e.rec.PostgresBin
	for _, v := range dbs.(canon.Array) {
		db := string(v.(canon.String))
		file := dumpDir + "/" + db + ".dump"
		code, err := e.exec(ctx, bin+"/pg_dump", append(append([]string{"--format=custom"}, conn...), "--file="+file, "--dbname="+db), nil, nil)
		if err != nil || code != 0 {
			e.note("pg_dump of %s failed (exit %d)", db, code)
			return
		}
		// A dump that pg_restore cannot list is not uploaded.
		if code, err := e.execQuiet(ctx, bin+"/pg_restore", []string{"--list", file}); err != nil || code != 0 {
			e.note("pg_restore cannot read the dump of %s", db)
			return
		}
	}
	code, err := e.exec(ctx, bin+"/pg_dumpall", append(append([]string{"--globals-only", "--no-role-passwords"}, conn...), "--file="+dumpDir+"/globals.sql"), nil, nil)
	if err != nil || code != 0 {
		e.note("pg_dumpall of the globals failed (exit %d)", code)
		return
	}
	var snapshot string
	e.effect = true
	code, err = e.exec(ctx, Restic, []string{"backup", "--json", "--no-cache", "--tag", "exponetdb", "--tag", "run:" + e.rec.RunID, dumpDir},
		e.resticEnv(), func(line string) {
			var m resticMessage
			if json.Unmarshal([]byte(line), &m) != nil {
				return
			}
			switch m.MessageType {
			case "status":
				if m.PercentDone != nil {
					p := *m.PercentDone * 100
					e.progress(&p, m.BytesDone)
				}
			case "summary":
				snapshot = m.SnapshotID
			}
		})
	e.finishExit(code, err)
	if snapshotRE.MatchString(snapshot) {
		e.outcome.Label = &snapshot
	}
}

func (e *engineRun) resticCheck(ctx context.Context) {
	code, err := e.exec(ctx, Restic, []string{"check", "--no-cache", "--read-data-subset=1/10"}, e.resticEnv(), nil)
	e.finishExit(code, err)
	if err == nil && code == 0 {
		n := int64(0)
		e.outcome.VerifyErrors = &n
	}
}

func (e *engineRun) resticForget(ctx context.Context) {
	ret, _ := e.args.Get("retention")
	days, _ := ret.(canon.Object).Get("logicalDays")
	n, ok := days.(canon.Number)
	if !ok || n < 1 {
		e.note("refused: a restic expiry needs a retention in days")
		return
	}
	e.effect = true
	code, err := e.exec(ctx, Restic, []string{"forget", "--no-cache", "--tag", "exponetdb", "--keep-within", strconv.Itoa(int(n)) + "d", "--prune"}, e.resticEnv(), nil)
	e.finishExit(code, err)
}

package helper

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsafe"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgwire"
)

// Restores into scratch (ADR-0038): pgBackRest restores the backup into the
// run's empty scratch directory as the engine user; engine-run then starts
// a temporary PostgreSQL on a Unix socket inside the scratch directory (no
// TCP listener, archiving off, the node's own pg_hba and configuration),
// waits for the recovery to end, runs the requested checks and stops the
// cluster again, so that a discard only removes files.

const (
	scratchConf  = "exponetdb-scratch.conf"
	scratchHba   = "exponetdb-scratch-hba.conf"
	scratchIdent = "exponetdb-scratch-ident.conf"
)

func (e *engineRun) phase(name string) func(ok bool) {
	i := len(e.outcome.Phases)
	e.outcome.Phases = append(e.outcome.Phases, phaseItem{Name: name, StartedAt: e.now(), Outcome: "running"})
	return func(ok bool) {
		fin := e.now()
		e.outcome.Phases[i].FinishedAt = &fin
		e.outcome.Phases[i].Outcome = map[bool]string{true: "passed", false: "failed"}[ok]
	}
}

func (e *engineRun) num(o canon.Object, name string) *int64 {
	v, _ := o.Get(name)
	n, ok := v.(canon.Number)
	if !ok {
		return nil
	}
	i := int64(n)
	return &i
}

func (e *engineRun) target() restoreTarget {
	v, _ := e.args.Get("target")
	t, _ := v.(canon.Object)
	opt := func(name string) *string {
		v, _ := t.Get(name)
		s, ok := v.(canon.String)
		if !ok {
			return nil
		}
		str := string(s)
		return &str
	}
	return restoreTarget{Label: opt("label"), Time: opt("time"), Lsn: opt("lsn"), Timeline: e.num(t, "timeline")}
}

// restoreArgs is pgBackRest's restore argv for the target: time, lsn,
// immediate (a label alone) or default (end of the archive).
func restoreTypeArgs(t restoreTarget) ([]string, error) {
	var args []string
	switch {
	case t.Time != nil:
		at, err := time.Parse(time.RFC3339Nano, *t.Time)
		if err != nil {
			return nil, errors.New("the target time is not a timestamp")
		}
		args = append(args, "--type=time", "--target="+at.UTC().Format("2006-01-02 15:04:05.999999")+"+00", "--target-action=promote")
	case t.Lsn != nil:
		if !lsnRE.MatchString(strings.ToUpper(*t.Lsn)) {
			return nil, errors.New("the target LSN is not an LSN")
		}
		args = append(args, "--type=lsn", "--target="+strings.ToUpper(*t.Lsn), "--target-action=promote")
	case t.Label != nil:
		args = append(args, "--type=immediate", "--target-action=promote")
	default:
		args = append(args, "--type=default")
	}
	if t.Label != nil {
		if !labelRE.MatchString(*t.Label) {
			return nil, errors.New("the label is not a pgBackRest label")
		}
		args = append(args, "--set="+*t.Label)
	}
	if t.Timeline != nil {
		args = append(args, "--target-timeline="+strconv.FormatInt(*t.Timeline, 10))
	}
	return args, nil
}

// scratchDir opens the run's scratch directory: no symlink on its path, a
// directory the engine user owns, 0700.
func (e *engineRun) scratchDir() (*fsafe.Dir, error) {
	parent, err := fsafe.OpenDirSearch(filepath.Dir(e.rec.ScratchDirectory))
	if err != nil {
		return nil, err
	}
	d, err := parent.OpenDir(filepath.Base(e.rec.ScratchDirectory))
	parent.Close()
	if err != nil {
		return nil, err
	}
	o, err := d.Owner()
	if err != nil || (!e.o.skipChecks && o.UID != os.Geteuid()) || o.Mode&0o077 != 0 {
		d.Close()
		return nil, errors.New("the scratch directory is not the engine user's private directory")
	}
	return d, nil
}

func (e *engineRun) restore(ctx context.Context) {
	if e.rec.PgBackRest == nil {
		e.note("the run has no pgBackRest repository")
		return
	}
	port := int(*e.num(e.args, "port"))
	e.outcome.Port = &port
	done := e.phase("restore")
	// The stanza must be the source cluster's (ADR-0038 §1).
	s, ok := e.pgbrInfo(ctx)
	if !ok {
		done(false)
		return
	}
	if s.systemID() != e.rec.SystemIdentifier {
		e.note("refused: the stanza belongs to another cluster (system identifier mismatch)")
		done(false)
		return
	}
	dir, err := e.scratchDir()
	if err != nil {
		e.note("refused: %v", err)
		done(false)
		return
	}
	names, err := dir.Names()
	dir.Close()
	if err != nil || len(names) != 0 {
		e.note("refused: the scratch directory is not empty")
		done(false)
		return
	}
	t := e.target()
	typeArgs, err := restoreTypeArgs(t)
	if err != nil {
		e.note("refused: %v", err)
		done(false)
		return
	}
	scratch := e.rec.ScratchDirectory
	args := e.pgbr(append([]string{"--pg1-path=" + scratch, "--archive-mode=off",
		"--tablespace-map-all=" + scratch + "/exponetdb-tablespaces", "--log-level-console=info"}, append(typeArgs, "restore")...)...)
	e.effect = true
	code, err := e.exec(ctx, PgBackRest, args, nil, nil)
	if err != nil || code != 0 {
		e.note("pgBackRest restore failed (exit %d)", code)
		if err == nil {
			e.outcome.ExitCode = &code
		}
		done(false)
		return
	}
	e.outcome.ExitCode = &code
	if r := e.writeScratchConfig(); r != "" {
		e.note("%s", r)
		done(false)
		return
	}
	done(true)
	recovered := e.phase("recover")
	proc, log, err := e.startScratch(port)
	if err != nil {
		e.note("the scratch cluster did not start: %v", err)
		recovered(false)
		return
	}
	stopped := false
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		end := e.phase("stop")
		end(e.stopScratch(proc))
	}
	defer stop()
	if err := e.waitPromoted(ctx, proc, port); err != nil {
		e.note("recovery did not end: %v", err)
		e.note("%s", log.String())
		recovered(false)
		return
	}
	recovered(true)
	verified := e.phase("verify")
	ok = e.runChecks(ctx, port, e.requestedChecks(), &t)
	verified(ok)
	stop()
	if ok && e.outcome.Phases[len(e.outcome.Phases)-1].Outcome == "passed" {
		e.outcome.State = "succeeded"
	}
}

func (e *engineRun) reverify(ctx context.Context) {
	port := int(*e.num(e.args, "port"))
	e.outcome.Port = &port
	if _, err := e.scratchDir(); err != nil {
		e.note("refused: %v", err)
		return
	}
	verified := e.phase("verify")
	proc, log, err := e.startScratch(port)
	if err != nil {
		e.note("the scratch cluster did not start: %v", err)
		verified(false)
		return
	}
	if err := e.waitPromoted(ctx, proc, port); err != nil {
		e.note("the scratch cluster is not ready: %v", err)
		e.note("%s", log.String())
		verified(false)
		end := e.phase("stop")
		end(e.stopScratch(proc))
		return
	}
	ok := e.runChecks(ctx, port, e.requestedChecks(), nil)
	verified(ok)
	end := e.phase("stop")
	stoppedOK := e.stopScratch(proc)
	end(stoppedOK)
	if ok && stoppedOK {
		e.outcome.State = "succeeded"
	}
}

func (e *engineRun) requestedChecks() []string {
	v, _ := e.args.Get("checks")
	var out []string
	for _, c := range v.(canon.Array) {
		out = append(out, string(c.(canon.String)))
	}
	return out
}

// writeScratchConfig writes the node's own configuration, pg_hba and
// pg_ident for the scratch cluster (never the restored ones).
func (e *engineRun) writeScratchConfig() string {
	dir, err := e.scratchDir()
	if err != nil {
		return "the scratch directory cannot be opened after the restore"
	}
	defer dir.Close()
	version, _, err := dir.ReadFile("PG_VERSION", 16)
	if err != nil || strings.TrimSpace(string(version)) != strconv.Itoa(e.rec.PostgresMajor) {
		return "the restored cluster is not of the run's PostgreSQL major"
	}
	s := e.rec.ScratchDirectory
	conf := strings.Join([]string{
		"# Written by the ExponetDB node for a scratch restore; never a served cluster.",
		"listen_addresses = ''",
		"unix_socket_directories = '" + s + "'",
		"archive_mode = off",
		"hba_file = '" + s + "/" + scratchHba + "'",
		"ident_file = '" + s + "/" + scratchIdent + "'",
		"ssl = off",
		"logging_collector = off",
		"cluster_name = 'exponetdb-scratch'",
		// Recovery checks max_connections and its kin against the source only
		// for hot standby; the scratch cluster takes no connection before it
		// is promoted, so the defaults serve any source.
		"hot_standby = off",
		"",
	}, "\n")
	o := fsafe.Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o600}
	for name, content := range map[string]string{
		scratchConf:  conf,
		scratchHba:   "local all all peer\n",
		scratchIdent: "",
	} {
		if err := dir.Create(name, []byte(content), o); err != nil {
			return "the scratch configuration could not be written"
		}
	}
	return ""
}

// startScratch starts the scratch postmaster directly (no shell, no pg_ctl):
// the command line overrides what a restored postgresql.auto.conf could set
// (archiving, listeners, sockets, files).
func (e *engineRun) startScratch(port int) (engineProc, *tail, error) {
	s := e.rec.ScratchDirectory
	bin := e.rec.PostgresBin + "/postgres"
	if err := e.binary(bin); err != nil {
		return nil, nil, err
	}
	args := []string{"-D", s,
		"-c", "config_file=" + s + "/" + scratchConf,
		"-c", "hba_file=" + s + "/" + scratchHba,
		"-c", "ident_file=" + s + "/" + scratchIdent,
		"-c", "port=" + strconv.Itoa(port),
		"-c", "listen_addresses=",
		"-c", "unix_socket_directories=" + s,
		"-c", "archive_mode=off",
		"-c", "ssl=off",
		"-c", "logging_collector=off",
		"-c", "hot_standby=off",
	}
	log := &tail{n: 8 * 1024}
	p, err := e.o.exec.start(engineCmd{Path: bin, Args: args, Out: &lockedWriter{w: log}})
	return p, log, err
}

func (e *engineRun) connect(ctx context.Context, port int, db string) (*pgwire.Conn, error) {
	return pgwire.Connect(ctx, pgwire.Options{SocketDirectory: e.rec.ScratchDirectory, Port: port, User: e.rec.EngineUser.Name,
		Database: db, StatementTimeout: 10 * time.Minute})
}

// waitPromoted waits until the scratch cluster accepts connections and is
// out of recovery, or the postmaster exits (a recovery target not reached
// stops it: PostgreSQL 13 and later).
func (e *engineRun) waitPromoted(ctx context.Context, p engineProc, port int) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-p.exited():
			code, _ := p.wait()
			return fmt.Errorf("the postmaster exited (%d)", code)
		case <-time.After(time.Second):
		}
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		c, err := e.connect(cctx, port, "postgres")
		if err == nil {
			rows, qerr := c.Query(cctx, `SELECT pg_catalog.pg_is_in_recovery() AS r`)
			_ = c.Close()
			if qerr == nil && len(rows.Each()) == 1 && !rows.Each()[0].Bool("r") {
				cancel()
				return nil
			}
		}
		cancel()
	}
}

// stopScratch: a fast shutdown, then immediate, then a kill.
func (e *engineRun) stopScratch(p engineProc) bool {
	for _, step := range []struct {
		sig  syscall.Signal
		wait time.Duration
	}{{syscall.SIGINT, 2 * time.Minute}, {syscall.SIGQUIT, 30 * time.Second}, {syscall.SIGKILL, 10 * time.Second}} {
		select {
		case <-p.exited():
			return step.sig == syscall.SIGINT
		default:
		}
		_ = p.signal(step.sig)
		select {
		case <-p.exited():
			return step.sig == syscall.SIGINT
		case <-time.After(step.wait):
		}
	}
	return false
}

// ----- checks -----

func (e *engineRun) check(name, outcome, detail string) {
	var d *string
	if detail != "" {
		d = &detail
	}
	e.outcome.Checks = append(e.outcome.Checks, checkItem{Check: name, Outcome: outcome, Detail: d})
}

// runChecks runs the requested checks; it reports whether none failed or
// erred (not_run is not a failure here; the Control Plane never counts it
// as passed).
func (e *engineRun) runChecks(ctx context.Context, port int, checks []string, t *restoreTarget) bool {
	ok := true
	for _, c := range checks {
		outcome, detail := "error", ""
		switch c {
		case "recovery_target_reached":
			if t == nil {
				outcome, detail = "not_run", "a reverification does not recover"
				break
			}
			outcome, detail = e.checkRecovery(ctx, port, *t)
		case "probe_simple":
			outcome, detail = e.probe(ctx, port, false)
		case "probe_extended":
			outcome, detail = e.probe(ctx, port, true)
		case "amcheck":
			outcome, detail = e.amcheck(ctx, port)
		case "row_counts":
			outcome, detail = e.rowCounts(ctx, port)
		default:
			continue
		}
		e.check(c, outcome, detail)
		ok = ok && (outcome == "passed" || outcome == "not_run")
	}
	return ok
}

func (e *engineRun) checkRecovery(ctx context.Context, port int, t restoreTarget) (string, string) {
	c, err := e.connect(ctx, port, "postgres")
	if err != nil {
		return "error", "the scratch cluster cannot be reached"
	}
	defer c.Close()
	rows, err := c.Query(ctx, `SELECT pg_catalog.pg_is_in_recovery() AS r, pg_catalog.pg_last_wal_replay_lsn()::text AS lsn,
		pg_catalog.pg_last_xact_replay_timestamp() AS at, (SELECT timeline_id FROM pg_catalog.pg_control_checkpoint()) AS tl`)
	if err != nil || len(rows.Each()) != 1 {
		return "error", "the recovery state cannot be read"
	}
	r := rows.Each()[0]
	if v := r.TextOrNil("lsn"); v != nil {
		l := strings.ToUpper(*v)
		e.outcome.RecoveryReachedLsn = &l
	}
	var at time.Time
	if v := r.TextOrNil("at"); v != nil {
		if parsed, ok := pgTimestamp(*v); ok {
			at = parsed
			s := parsed.Format(time.RFC3339Nano)
			e.outcome.RecoveryReachedAt = &s
		}
	}
	if tl := r.Int("tl"); tl > 0 {
		e.outcome.Timeline = &tl
	}
	if r.Bool("r") {
		return "failed", "the cluster is still in recovery"
	}
	switch {
	case t.Time != nil:
		target, _ := time.Parse(time.RFC3339Nano, *t.Time)
		if !at.IsZero() && at.After(target) {
			return "failed", "a transaction after the target time was replayed"
		}
		if at.IsZero() {
			return "passed", "recovery ended at the target time (no commit after the backup was replayed)"
		}
		return "passed", "recovery ended at the target time (last replayed commit " + at.Format(time.RFC3339) + ")"
	case t.Lsn != nil:
		target, _ := parseLsn(*t.Lsn)
		got, ok := parseLsn(strOr(e.outcome.RecoveryReachedLsn))
		if !ok || got < target {
			return "failed", "the replayed LSN is before the target LSN"
		}
		return "passed", "replayed to " + strOr(e.outcome.RecoveryReachedLsn)
	}
	return "passed", "recovery ended and the cluster was promoted"
}

func pgTimestamp(s string) (time.Time, bool) {
	for _, layout := range []string{"2006-01-02 15:04:05.999999-07", "2006-01-02 15:04:05.999999-07:00", "2006-01-02 15:04:05-07"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

func (e *engineRun) probe(ctx context.Context, port int, extended bool) (string, string) {
	c, err := e.connect(ctx, port, "postgres")
	if err != nil {
		return "error", "the scratch cluster cannot be reached"
	}
	defer c.Close()
	if extended {
		rows, err := c.Query(ctx, `SELECT $1::int4 + 1 AS v`, 41)
		if err != nil || len(rows.Each()) != 1 || rows.Each()[0].Text("v") != "42" {
			return "failed", "the extended-protocol probe did not answer 42"
		}
		return "passed", ""
	}
	rows, err := c.SimpleQuery(ctx, `SELECT 1 AS v`)
	if err != nil || len(rows.Each()) != 1 || rows.Each()[0].Text("v") != "1" {
		return "failed", "the simple-protocol probe did not answer 1"
	}
	return "passed", ""
}

func (e *engineRun) databases(ctx context.Context, port int) ([]string, error) {
	c, err := e.connect(ctx, port, "postgres")
	if err != nil {
		return nil, err
	}
	defer c.Close()
	rows, err := c.Query(ctx, `SELECT datname FROM pg_catalog.pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1 LIMIT 256`)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, r := range rows.Each() {
		out = append(out, r.Text("datname"))
	}
	return out, nil
}

// amcheck runs bt_index_check on every valid B-tree index of every
// database that has the amcheck extension; a database without it is not
// checked, and the check is then not_run, never passed (ADR-0038 §4).
func (e *engineRun) amcheck(ctx context.Context, port int) (string, string) {
	dbs, err := e.databases(ctx, port)
	if err != nil {
		return "error", "the databases cannot be listed"
	}
	checked, failed, missing := 0, 0, 0
	for _, db := range dbs {
		c, err := e.connect(ctx, port, db)
		if err != nil {
			return "error", "a database cannot be reached"
		}
		ext, err := c.Query(ctx, `SELECT n.nspname FROM pg_catalog.pg_extension x JOIN pg_catalog.pg_namespace n ON n.oid = x.extnamespace WHERE x.extname = 'amcheck'`)
		if err != nil {
			_ = c.Close()
			return "error", "the extensions cannot be read"
		}
		if len(ext.Each()) == 0 {
			missing++
			_ = c.Close()
			continue
		}
		nsp := quoteIdentifier(ext.Each()[0].Text("nspname"))
		idx, err := c.Query(ctx, `SELECT c.oid::int8 AS oid FROM pg_catalog.pg_index i
			JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
			JOIN pg_catalog.pg_am am ON am.oid = c.relam
			WHERE am.amname = 'btree' AND i.indisvalid AND i.indisready AND c.relpersistence <> 't'
			ORDER BY 1 LIMIT 100000`)
		if err != nil {
			_ = c.Close()
			return "error", "the indexes cannot be listed"
		}
		for _, r := range idx.Each() {
			if _, err := c.Query(ctx, `SELECT `+nsp+`.bt_index_check($1::pg_catalog.oid)`, r.Text("oid")); err != nil {
				var pe *pgwire.Error
				if !errors.As(err, &pe) {
					_ = c.Close()
					return "error", "the index check was interrupted"
				}
				failed++
			}
			checked++
		}
		_ = c.Close()
	}
	detail := fmt.Sprintf("%d indexes checked in %d of %d databases", checked, len(dbs)-missing, len(dbs))
	switch {
	case failed > 0:
		return "failed", fmt.Sprintf("%d of %d indexes failed bt_index_check", failed, checked)
	case missing > 0 || len(dbs) == 0:
		return "not_run", detail + "; amcheck is missing in the others"
	}
	return "passed", detail
}

func quoteIdentifier(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

func (e *engineRun) rowCounts(ctx context.Context, port int) (string, string) {
	if len(e.rec.RowCounts) == 0 {
		return "not_run", "no tables were configured"
	}
	outside := 0
	for _, rc := range e.rec.RowCounts {
		if !safeDatabaseRE.MatchString(rc.Database) || !managedIdentRE.MatchString(rc.Schema) || !managedIdentRE.MatchString(rc.Table) {
			return "error", "a configured table name is invalid"
		}
		c, err := e.connect(ctx, port, rc.Database)
		if err != nil {
			return "error", "database " + rc.Database + " cannot be reached"
		}
		rows, err := c.Query(ctx, `SELECT count(*) AS n FROM `+quoteIdentifier(rc.Schema)+`.`+quoteIdentifier(rc.Table))
		_ = c.Close()
		if err != nil || len(rows.Each()) != 1 {
			return "error", "table " + rc.Schema + "." + rc.Table + " cannot be counted"
		}
		n := rows.Each()[0].Int("n")
		if n < rc.Min || n > rc.Max {
			outside++
		}
	}
	if outside > 0 {
		return "failed", fmt.Sprintf("%d of %d tables are outside their bounds", outside, len(e.rec.RowCounts))
	}
	return "passed", fmt.Sprintf("%d tables within their bounds", len(e.rec.RowCounts))
}

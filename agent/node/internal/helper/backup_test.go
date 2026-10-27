package helper

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsafe"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
)

// Wave 9 Part B: the backup and restore operations with a scripted systemd
// and scripted engines (ADR-0036, ADR-0037, ADR-0038). The real engines run
// in the pglab test; real systemd is not proven here.

const (
	repoID     = "bkr_01M60000000000000000000001"
	runA       = "run_01M60000000000000000000002"
	runB       = "run_01M60000000000000000000004"
	runC       = "run_01M60000000000000000000006"
	cipherPass = "Zm9vYmFyU2VjcmV0Q2lwaGVyUGFzc3dvcmQxMjM0NTY"
	resticPass = "restic-password-that-must-never-leak"
	awsSecret  = "AWSSECRETVALUEthatmustneverleak0123456789"
)

// scriptRunner answers commands from a function and records them.
type scriptRunner struct {
	mu    sync.Mutex
	calls []Command
	fn    func(c Command) (Output, error)
}

func (s *scriptRunner) Run(_ context.Context, c Command) (Output, error) {
	s.mu.Lock()
	s.calls = append(s.calls, c)
	fn := s.fn
	s.mu.Unlock()
	if fn == nil {
		return Output{}, nil
	}
	return fn(c)
}

func (s *scriptRunner) find(path, contains string) []Command {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Command
	for _, c := range s.calls {
		if c.Path == path && strings.Contains(strings.Join(c.Args, " "), contains) {
			out = append(out, c)
		}
	}
	return out
}

type benv struct {
	*env
	run   *scriptRunner
	units map[string]string // unit -> active | failed | "" (not loaded)
	info  string            // pgbackrest info JSON
	mu    sync.Mutex
	uid   int
	gid   int
}

func (b *benv) setUnit(unit, state string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.units[unit] = state
}

func writeFile(t testing.TB, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func newBackupEnv(t testing.TB) *benv {
	e := newEnv(t)
	b := &benv{env: e, units: map[string]string{}, uid: e.dataUID, gid: e.dataUID}
	if os.Geteuid() != 0 {
		b.gid = os.Getegid()
	}
	root := e.root
	for _, d := range []string{"/var/lib/exponetdb-node-engine", "/etc/exponetdb-node/repositories"} {
		if err := os.MkdirAll(root+d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(root+"/var/lib/exponetdb-node-engine", 0o711); err != nil {
		t.Fatal(err)
	}
	writeFile(t, root+e.in.DataDirectory+"/PG_VERSION", "17\n", 0o600)
	writeFile(t, root+"/etc/pgbackrest/pgbackrest.conf", "[global]\nrepo1-path=/var/lib/pgbackrest\nrepo1-cipher-type=aes-256-cbc\nrepo1-cipher-pass="+
		cipherPass+"\nlog-path=/var/log/pgbackrest\n\n[main]\npg1-path=/var/lib/postgresql/17/main\n", 0o640)
	for _, bin := range []string{"/usr/bin/pgbackrest", "/usr/bin/restic", "/usr/lib/postgresql/17/bin/pg_dump", "/usr/lib/postgresql/17/bin/pg_dumpall",
		"/usr/lib/postgresql/17/bin/pg_restore", "/usr/lib/postgresql/17/bin/postgres", "/usr/lib/postgresql/17/bin/pg_ctl"} {
		writeFile(t, root+bin, "#!/bin/false\n", 0o755)
	}
	// 55401 listens on 127.0.0.1.
	writeFile(t, root+"/proc/1/net/tcp", "  sl  local_address rem_address   st\n   0: 0100007F:D869 00000000:0000 0A\n   1: 0100007F:1538 00000000:0000 01\n", 0o644)
	e.h.lookupUser = func(uid int) (string, error) {
		if uid == b.uid {
			return "postgres", nil
		}
		return "", fmt.Errorf("unknown uid")
	}
	b.run = &scriptRunner{fn: b.answer}
	e.h.Runner = b.run
	b.info = pgbrInfoFixture(sysid)
	return b
}

func (b *benv) mode(m string) {
	if m == "" {
		_ = os.Remove(b.root + "/etc/exponetdb-node/repositories/" + repoID + "/mode")
		return
	}
	writeFile(b.t, b.root+"/etc/exponetdb-node/repositories/"+repoID+"/mode", m+"\n", 0o644)
	writeFile(b.t, b.root+"/etc/exponetdb-node/repositories/"+repoID+"/pgbackrest", "# bound by the operator\nstanza=main\nrepo=1\n", 0o644)
}

// answer is the scripted host: systemctl show reports the units of b.units,
// systemd-run --wait runs the engine reads.
func (b *benv) answer(c Command) (Output, error) {
	args := strings.Join(c.Args, " ")
	switch c.Path {
	case Systemctl:
		if len(c.Args) > 0 && c.Args[0] == "show" && strings.Contains(args, "ExecMainStatus") {
			b.mu.Lock()
			defer b.mu.Unlock()
			var out strings.Builder
			for _, u := range c.Args[3:] {
				st := b.units[u]
				load, active, result := "loaded", st, "success"
				switch st {
				case "":
					load, active = "not-found", "inactive"
				case "failed":
					result = "exit-code"
				}
				fmt.Fprintf(&out, "Id=%s\nLoadState=%s\nActiveState=%s\nSubState=x\nResult=%s\nExecMainStatus=1\nExecMainCode=1\n\n", u, load, active, result)
			}
			return Output{Stdout: []byte(out.String())}, nil
		}
	case PgBackRest, Restic:
		if args == "version" {
			return Output{Stdout: []byte("pgBackRest 2.60.0\n")}, nil
		}
	case SystemdRun:
		if strings.HasPrefix(args, "--wait") {
			inner := args[strings.Index(args, " -- ")+4:]
			switch {
			case strings.HasPrefix(inner, PgBackRest) && strings.HasSuffix(inner, " info"):
				return Output{Stdout: []byte(b.info)}, nil
			case strings.HasPrefix(inner, Restic+" snapshots"):
				// B-5: the environment file systemd reads lies in root's
				// private directory, never in the engine user's.
				for _, a := range c.Args {
					if env, ok := strings.CutPrefix(a, "--property=EnvironmentFile="); ok {
						info, err := os.Lstat(filepath.Dir(env))
						if err != nil || filepath.Base(filepath.Dir(env)) != "private" || info.Mode().Perm() != 0o700 || ownerOf(info) != b.h.rootUID() {
							return Output{ExitCode: 99}, nil
						}
					}
				}
				return Output{Stdout: []byte(`[{"time":"2026-10-26T12:00:00.123+02:00","id":"` + strings.Repeat("ab", 32) + `","tags":["exponetdb"]}]`)}, nil
			case strings.Contains(inner, "pg_ctl status"):
				return Output{ExitCode: 3}, nil
			}
		}
	}
	return Output{}, nil
}

func pgbrInfoFixture(id string) string {
	return `[{"archive":[{"database":{"id":1,"repo-key":1},"id":"17-1","max":"000000010000000000000006","min":"000000010000000000000001"}],
"backup":[
{"archive":{"start":"000000010000000000000002","stop":"000000010000000000000002"},"backrest":{"format":5,"version":"2.60.0"},"database":{"id":1,"repo-key":1},"error":false,
 "info":{"delta":23176062,"repository":{"delta":3028544,"size":3028544},"size":23176062},"label":"20261005-010000F","lsn":{"start":"0/2000028","stop":"0/2000120"},"prior":null,"reference":null,"timestamp":{"start":1791162000,"stop":1791162100},"type":"full"},
{"archive":{"start":"000000010000000000000003","stop":"000000010000000000000003"},"backrest":{"format":5,"version":"2.60.0"},"database":{"id":1,"repo-key":1},"error":false,
 "info":{"delta":3,"repository":{"delta":3,"size":3},"size":23176062},"label":"20261005-010000F_20261005-020000I","lsn":{"start":"0/3000028","stop":"0/3000120"},"prior":"20261005-010000F","reference":["20261005-010000F"],"timestamp":{"start":1791165600,"stop":1791165700},"type":"incr"},
{"archive":{"start":"000000010000000000000004","stop":"000000010000000000000004"},"backrest":{"format":5,"version":"2.60.0"},"database":{"id":1,"repo-key":1},"error":false,
 "info":{"delta":23176062,"repository":{"delta":3028544,"size":3028544},"size":23176062},"label":"20261006-010000F","lsn":{"start":"0/4000028","stop":"0/4000120"},"prior":null,"reference":null,"timestamp":{"start":1791248400,"stop":1791248500},"type":"full"},
{"archive":{"start":"000000010000000000000005","stop":"000000010000000000000005"},"backrest":{"format":5,"version":"2.60.0"},"database":{"id":1,"repo-key":1},"error":false,
 "info":{"delta":5,"repository":{"delta":5,"size":5},"size":23176062},"label":"20261006-010000F_20261006-020000D","lsn":{"start":"0/5000028","stop":"0/5000120"},"prior":"20261006-010000F","reference":["20261006-010000F"],"timestamp":{"start":1791252000,"stop":1791252100},"type":"diff"},
{"archive":{"start":"000000010000000000000006","stop":"000000010000000000000006"},"backrest":{"format":5,"version":"2.60.0"},"database":{"id":1,"repo-key":1},"error":false,
 "info":{"delta":6,"repository":{"delta":6,"size":6},"size":23176062},"label":"20261006-010000F_20261006-030000I","lsn":{"start":"0/6000028","stop":"0/6000120"},"prior":"20261006-010000F_20261006-020000D","reference":["20261006-010000F"],"timestamp":{"start":1791255600,"stop":1791255700},"type":"incr"}],
"cipher":"aes-256-cbc","db":[{"id":1,"repo-key":1,"system-id":` + id + `,"version":"17"}],"name":"main",
"repo":[{"cipher":"aes-256-cbc","key":1,"status":{"code":0,"message":"ok"}}],
"status":{"code":0,"lock":{"backup":{"held":false}},"message":"ok"}}]`
}

func pgbrRepo() canon.Object {
	return canon.Object{{Name: "repositoryId", Value: canon.String(repoID)}, {Name: "engine", Value: canon.String("pgbackrest")},
		{Name: "stanza", Value: canon.String("main")}, {Name: "repoIndex", Value: canon.Number(1)}}
}

func resticRepo() canon.Object {
	return canon.Object{{Name: "repositoryId", Value: canon.String(repoID)}, {Name: "engine", Value: canon.String("restic")},
		{Name: "stanza", Value: canon.Null{}}, {Name: "repoIndex", Value: canon.Null{}}}
}

func runArgs(run, kind string, repo canon.Object, dbs ...string) canon.Object {
	list := canon.Array{}
	for _, d := range dbs {
		list = append(list, canon.String(d))
	}
	return canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: repo},
		{Name: "runId", Value: canon.String(run)}, {Name: "kind", Value: canon.String(kind)}, {Name: "databases", Value: list}}
}

func restoreJobArgs(run string, port int) canon.Object {
	return canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: pgbrRepo()},
		{Name: "runId", Value: canon.String(run)}, {Name: "purpose", Value: canon.String("drill")},
		{Name: "target", Value: canon.Object{{Name: "label", Value: canon.Null{}}, {Name: "time", Value: canon.String("2026-10-06T02:30:00Z")},
			{Name: "lsn", Value: canon.Null{}}, {Name: "timeline", Value: canon.Number(1)}}},
		{Name: "port", Value: canon.Number(port)},
		{Name: "checks", Value: canon.Array{canon.String("probe_simple"), canon.String("row_counts")}},
		{Name: "rowCounts", Value: canon.Array{canon.Object{{Name: "database", Value: canon.String("app")}, {Name: "schema", Value: canon.String("public")},
			{Name: "table", Value: canon.String("accounts")}, {Name: "min", Value: canon.Number(1)}, {Name: "max", Value: canon.Number(10)}}}},
	}
}

func (b *benv) runsRoot() string { return b.root + "/var/lib/exponetdb-node-engine/runs" }

func (b *benv) record(run string) runRecord {
	b.t.Helper()
	data, err := os.ReadFile(b.runsRoot() + "/" + run + "/record.json")
	if err != nil {
		b.t.Fatal(err)
	}
	var rec runRecord
	if err := decodeStrict(data, &rec); err != nil {
		b.t.Fatal(err)
	}
	return rec
}

func statusArgs(rec runRecord) canon.Object {
	return canon.Object{{Name: "runId", Value: canon.String(rec.RunID)}, {Name: "startJobId", Value: canon.String(rec.StartJobID)},
		{Name: "startArgsHash", Value: canon.String(rec.StartArgsHash)}}
}

func (b *benv) status(rec runRecord) canon.Object {
	b.t.Helper()
	r := b.mustCall(OpRunStatus, b.job("run.status", statusArgs(rec)))
	if err := b.h.Schema.ValidateResult("run.status@1", r); err != nil {
		b.t.Fatalf("run.status result: %v", err)
	}
	return r
}

func noSecrets(t testing.TB, what string, s string) {
	t.Helper()
	for _, secret := range []string{cipherPass, resticPass, awsSecret} {
		if strings.Contains(s, secret) {
			t.Fatalf("%s carries a secret: %s", what, s)
		}
	}
}

func (b *benv) allArgv() string {
	b.run.mu.Lock()
	defer b.run.mu.Unlock()
	var all []string
	for _, c := range b.run.calls {
		all = append(all, c.Path+" "+strings.Join(c.Args, " "))
	}
	return strings.Join(all, "\n")
}

// ----- starts -----

func TestBackupRunStartsAFixedUnit(t *testing.T) {
	b := newBackupEnv(t)
	b.mode(ModeOwned)
	r := b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())))
	if err := b.h.Schema.ValidateResult("backup.run@1", r); err != nil {
		t.Fatal(err)
	}
	if str(r, "unit") != "exponetdb-run-"+runA+".service" || str(r, "runId") != runA {
		t.Fatalf("%v", r)
	}
	starts := b.run.find(SystemdRun, "--unit=")
	if len(starts) != 1 {
		t.Fatalf("starts %v", starts)
	}
	work := b.runsRoot() + "/" + runA + "/work"
	want := []string{"--unit=exponetdb-run-" + runA + ".service", "--description=ExponetDB engine run " + runA, "--quiet", "--service-type=exec",
		fmt.Sprintf("--property=User=%d", b.uid), fmt.Sprintf("--property=Group=%d", b.gid), "--property=NoNewPrivileges=yes",
		"--property=PrivateTmp=yes", "--property=PrivateDevices=yes", "--property=ProtectSystem=strict", "--property=ProtectHome=yes",
		"--property=ProtectKernelTunables=yes", "--property=ProtectKernelModules=yes", "--property=ProtectControlGroups=yes",
		"--property=RestrictSUIDSGID=yes", "--property=LimitCORE=0", "--property=UMask=0077", "--property=KillMode=control-group",
		"--property=CPUWeight=50", "--property=IOWeight=50", "--property=TasksMax=256",
		"--property=ReadWritePaths=" + work, "--property=ReadWritePaths=-/var/log/pgbackrest", "--property=ReadWritePaths=-/var/spool/pgbackrest",
		"--property=ReadWritePaths=-/var/lib/pgbackrest",
		"--property=BindPaths=-/tmp/pgbackrest",
		"--property=MemoryMax=2G", "--property=RuntimeMaxSec=43200", "--property=TimeoutStopSec=90", "--property=Restart=no",
		"--property=StandardOutput=null", "--property=StandardError=null",
		"--", "/usr/sbin/exponetdb-node-helper", "engine-run", "--run", runA}
	if got := strings.Join(starts[0].Args, "\n"); got != strings.Join(want, "\n") {
		t.Fatalf("systemd-run argv:\n%s\nwant:\n%s", got, strings.Join(want, "\n"))
	}
	noSecrets(t, "argv", b.allArgv())
	rec := b.record(runA)
	if rec.Purpose != "backup" || rec.Domain != "backup" || rec.SystemIdentifier != sysid || rec.EngineUser.Name != "postgres" ||
		rec.PgBackRest == nil || rec.PgBackRest.Stanza != "main" || rec.PgBackRest.Repo != 1 || rec.Unit != UnitName(runA) {
		t.Fatalf("record %+v", rec)
	}
	data, _ := os.ReadFile(b.runsRoot() + "/" + runA + "/record.json")
	noSecrets(t, "record", string(data))
	for path, want := range map[string]os.FileMode{b.runsRoot() + "/" + runA: 0o750, work: 0o700, b.runsRoot() + "/" + runA + "/record.json": 0o640, b.runsRoot(): 0o711} {
		info, err := os.Lstat(path)
		if err != nil || info.Mode().Perm() != want {
			t.Fatalf("%s: %v %v", path, info, err)
		}
	}
	if info, _ := os.Lstat(work); ownerOf(info) != b.uid {
		t.Fatal("the work directory is not the engine user's")
	}
	// The same run id again, by another job: refused, nothing started.
	b.setUnit(UnitName(runA), "")
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())), CodePreconditionFailed)
	if len(b.run.find(SystemdRun, "--unit=")) != 1 {
		t.Fatal("a second start of one run id ran")
	}
}

func TestRepositoryModesGateRuns(t *testing.T) {
	b := newBackupEnv(t)
	start := func(kind string, run string) *ErrorBody {
		_, refusal := b.call(OpBackupRun, b.job("backup.run", runArgs(run, kind, pgbrRepo())))
		return refusal
	}
	ids := []string{"run_01M6000000000000000000000A", "run_01M6000000000000000000000B", "run_01M6000000000000000000000C",
		"run_01M6000000000000000000000D", "run_01M6000000000000000000000E"}
	// No mode file: adopted_observed, no runs at all.
	if r := start("incremental", ids[0]); r == nil || r.Code != CodePreconditionFailed {
		t.Fatalf("observed: %+v", r)
	}
	b.mode(ModeAdoptedRuns)
	if r := start("full", ids[0]); r == nil || r.Code != CodePreconditionFailed {
		t.Fatalf("adopted_runs full: %+v", r)
	}
	if r := start("differential", ids[0]); r == nil || r.Code != CodePreconditionFailed {
		t.Fatalf("adopted_runs diff: %+v", r)
	}
	if r := start("incremental", ids[0]); r != nil {
		t.Fatalf("adopted_runs incremental: %+v", r)
	}
	b.setUnit(UnitName(ids[0]), "")
	writeFile(t, b.runsRoot()+"/"+ids[0]+"/work/outcome.json", `{"schema":"exponetdb.engine-outcome/v1","state":"succeeded","exitCode":0,"finishedAt":"2026-10-07T12:00:00Z","excerpt":"","label":null,"verifyErrors":null,"recoveryReachedLsn":null,"recoveryReachedAt":null,"timeline":null,"port":null,"checks":[],"phases":[]}`, 0o600)
	// Expiry needs owned.
	expire := canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: pgbrRepo()}, {Name: "runId", Value: canon.String(ids[1])},
		{Name: "retention", Value: canon.Object{{Name: "fullCount", Value: canon.Number(2)}, {Name: "differentialCount", Value: canon.Null{}}, {Name: "logicalDays", Value: canon.Null{}}}},
		{Name: "keepLabels", Value: canon.Array{}}}
	b.mustRefuse(OpBackupExpire, b.job("backup.expire", expire), CodePreconditionFailed)
	// Verification is allowed in any mode.
	verifyArgs := canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: pgbrRepo()}, {Name: "runId", Value: canon.String(ids[2])},
		{Name: "label", Value: canon.Null{}}, {Name: "snapshot", Value: canon.Null{}}}
	b.mode("")
	b.mustCall(OpBackupVerify, b.job("backup.verify", verifyArgs))
	b.setUnit(UnitName(ids[2]), "failed")
	b.mode(ModeOwned)
	b.mustCall(OpBackupExpire, b.job("backup.expire", expire))
	b.setUnit(UnitName(ids[1]), "failed")
	if r := start("full", ids[3]); r != nil {
		t.Fatalf("owned full: %+v", r)
	}
	b.setUnit(UnitName(ids[3]), "failed")
	// A mode file with another word, or one others can write: refused.
	b.mode("owned-please")
	if r := start("full", ids[4]); r == nil || r.Code != CodePreconditionFailed {
		t.Fatalf("bad mode: %+v", r)
	}
	b.mode(ModeOwned)
	if err := os.Chmod(b.root+"/etc/exponetdb-node/repositories/"+repoID+"/mode", 0o666); err != nil {
		t.Fatal(err)
	}
	if r := start("full", ids[4]); r == nil || r.Code != CodePreconditionFailed {
		t.Fatalf("writable mode: %+v", r)
	}
	// A pgBackRest configuration others can write: refused.
	b.mode(ModeOwned)
	if err := os.Chmod(b.root+"/etc/pgbackrest/pgbackrest.conf", 0o666); err != nil {
		t.Fatal(err)
	}
	if r := start("full", ids[4]); r == nil || r.Code != CodePreconditionFailed {
		t.Fatalf("writable pgbackrest.conf: %+v", r)
	}
	// A stanza or repository the host does not configure: refused.
	if err := os.Chmod(b.root+"/etc/pgbackrest/pgbackrest.conf", 0o640); err != nil {
		t.Fatal(err)
	}
	other := pgbrRepo()
	other[2].Value = canon.String("other")
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(ids[4], "full", other)), CodePreconditionFailed)
	other = pgbrRepo()
	other[3].Value = canon.Number(3)
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(ids[4], "full", other)), CodePreconditionFailed)
}

func TestOneRunPerClusterAndDomain(t *testing.T) {
	b := newBackupEnv(t)
	b.mode(ModeOwned)
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())))
	b.setUnit(UnitName(runA), "active")
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runB, "incremental", pgbrRepo())), CodePreconditionFailed)
	// A restore is another domain.
	b.mustCall(OpRestoreExecute, b.job("restore.execute", restoreJobArgs(runC, 55402)))
	// A record whose unit never appeared is "starting" within its grace.
	b.setUnit(UnitName(runA), "")
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runB, "incremental", pgbrRepo())), CodePreconditionFailed)
	// After the grace it is lost and settled; the next start goes.
	b.clk.T = b.clk.T.Add(3 * time.Minute)
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runB, "incremental", pgbrRepo())))
	st := b.status(b.record(runA))
	if str(st, "state") != "lost" {
		t.Fatalf("%v", st)
	}
}

func TestRunStatusIsBoundToItsStartJob(t *testing.T) {
	b := newBackupEnv(t)
	b.mode(ModeOwned)
	// Unknown run: not_found.
	st := b.mustCall(OpRunStatus, b.job("run.status", canon.Object{{Name: "runId", Value: canon.String(runA)},
		{Name: "startJobId", Value: canon.String("job_01M60000000000000000000003")},
		{Name: "startArgsHash", Value: canon.String("sha256:" + strings.Repeat("a", 64))}}))
	if str(st, "state") != "not_found" || b.h.Schema.ValidateResult("run.status@1", st) != nil {
		t.Fatalf("%v", st)
	}
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())))
	rec := b.record(runA)
	b.setUnit(rec.Unit, "active")
	if st := b.status(rec); str(st, "state") != "running" || str(st, "startJobId") != rec.StartJobID || str(st, "startArgsHash") != rec.StartArgsHash {
		t.Fatalf("%v", st)
	}
	// Another job's binding: refused.
	wrong := statusArgs(rec)
	wrong[2].Value = canon.String("sha256:" + strings.Repeat("b", 64))
	b.mustRefuse(OpRunStatus, b.job("run.status", wrong), CodePreconditionFailed)
	wrong = statusArgs(rec)
	wrong[1].Value = canon.String("job_01M60000000000000000000009")
	b.mustRefuse(OpRunStatus, b.job("run.status", wrong), CodePreconditionFailed)
	// The engine's outcome (untrusted): bounded, redacted, checked.
	writeFile(t, b.runsRoot()+"/"+runA+"/work/outcome.json", `{"schema":"exponetdb.engine-outcome/v1","state":"succeeded","exitCode":0,
"finishedAt":"2026-10-07T12:30:00Z","excerpt":"INFO: backup command end\nrepo1-cipher-pass=`+cipherPass+`\nAWS_SECRET_ACCESS_KEY=`+awsSecret+`",
"label":"20261007-120000F","verifyErrors":null,"recoveryReachedLsn":"0/zz","recoveryReachedAt":null,"timeline":0,"port":80,
"checks":[{"check":"shell","outcome":"passed","detail":null}],"phases":[]}`, 0o600)
	b.setUnit(rec.Unit, "")
	st = b.status(rec)
	out, _ := canon.Canonicalize(st)
	noSecrets(t, "status", string(out))
	o, _ := st.Get("outcome")
	label, _ := o.(canon.Object).Get("label")
	if str(st, "state") != "succeeded" || label != canon.String("20261007-120000F") || !strings.Contains(str(st, "excerpt"), "<redacted>") {
		t.Fatalf("%s", out)
	}
	if _, err := os.Stat(b.runsRoot() + "/" + runA + "/result.json"); err != nil {
		t.Fatal("the terminal state was not recorded")
	}
	// Terminal stays terminal, whatever the files say later.
	writeFile(t, b.runsRoot()+"/"+runA+"/work/outcome.json", `{}`, 0o600)
	if st := b.status(rec); str(st, "state") != "succeeded" {
		t.Fatalf("%v", st)
	}
	// A unit that failed without an outcome: failed with systemd's result.
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runB, "incremental", pgbrRepo())))
	b.setUnit(UnitName(runB), "failed")
	if st := b.status(b.record(runB)); str(st, "state") != "failed" {
		t.Fatalf("%v", st)
	}
	// A garbled outcome: failed, never trusted.
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runC, "incremental", pgbrRepo())))
	writeFile(t, b.runsRoot()+"/"+runC+"/work/outcome.json", `{"schema":"exponetdb.engine-outcome/v1","state":"succeeded","extra":1}`, 0o600)
	b.setUnit(UnitName(runC), "")
	if st := b.status(b.record(runC)); str(st, "state") != "failed" {
		t.Fatalf("%v", st)
	}
}

func TestRunCancel(t *testing.T) {
	b := newBackupEnv(t)
	b.mode(ModeOwned)
	cancel := func(run string) string {
		r := b.mustCall(OpRunCancel, b.job("run.cancel", canon.Object{{Name: "runId", Value: canon.String(run)}}))
		if err := b.h.Schema.ValidateResult("run.cancel@1", r); err != nil {
			t.Fatal(err)
		}
		return str(r, "state")
	}
	if cancel(runA) != "not_found" {
		t.Fatal("not_found")
	}
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())))
	b.setUnit(UnitName(runA), "active")
	if cancel(runA) != "stopping" {
		t.Fatal("stopping")
	}
	if stops := b.run.find(Systemctl, "stop --no-block -- "+UnitName(runA)); len(stops) != 1 {
		t.Fatalf("stop %v", stops)
	}
	// Stopped without an outcome after a cancel: failed, effect unknown.
	b.setUnit(UnitName(runA), "failed")
	if st := b.status(b.record(runA)); str(st, "state") != "failed" || !strings.Contains(str(st, "excerpt"), "cancel") {
		t.Fatalf("%v", st)
	}
	if cancel(runA) != "already_finished" {
		t.Fatal("already_finished")
	}
}

func TestRestoreExecuteScratchRules(t *testing.T) {
	b := newBackupEnv(t)
	scratch := b.root + "/var/lib/exponetdb-node-engine/scratch"
	// Port in use (55401 listens).
	b.mustRefuse(OpRestoreExecute, b.job("restore.execute", restoreJobArgs(runA, 55401)), CodePreconditionFailed)
	// The scratch directory exists.
	if err := os.MkdirAll(scratch+"/"+runA, 0o700); err != nil {
		t.Fatal(err)
	}
	b.mustRefuse(OpRestoreExecute, b.job("restore.execute", restoreJobArgs(runA, 55402)), CodePreconditionFailed)
	_ = os.RemoveAll(scratch)
	// A symlinked scratch root.
	if err := os.MkdirAll(b.root+"/elsewhere", 0o711); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(b.root+"/elsewhere", scratch); err != nil {
		t.Fatal(err)
	}
	b.mustRefuse(OpRestoreExecute, b.job("restore.execute", restoreJobArgs(runA, 55402)), CodePreconditionFailed)
	_ = os.Remove(scratch)
	// A scratch root inside an instance's data directory.
	in := b.in
	in.LocalName, in.Unit, in.DataDirectory = "17/other", "postgresql@17-other.service", "/var/lib/exponetdb-node-engine/scratch"
	in.ConfigFile, in.HbaFile, in.ManagedInclude, in.TLSCertificateFile, in.TLSKeyFile = "/x/a", "/x/b", "/x/c", "", ""
	b.h.Config.Instances = append(b.h.Config.Instances, in)
	b.mustRefuse(OpRestoreExecute, b.job("restore.execute", restoreJobArgs(runA, 55402)), CodePreconditionFailed)
	b.h.Config.Instances = b.h.Config.Instances[:1]
	_ = os.RemoveAll(scratch)
	// Another cluster's identity: refused by the helper's own pg_control read.
	other := restoreJobArgs(runA, 55402)
	other[0].Value = canon.Object{{Name: "localName", Value: canon.String("17/main")}, {Name: "systemIdentifier", Value: canon.String("1")}}
	b.mustRefuse(OpRestoreExecute, b.job("restore.execute", other), CodePreconditionFailed)
	// The good case: the scratch directory is the engine user's, 0700, and
	// the only other path the unit may write.
	b.mustCall(OpRestoreExecute, b.job("restore.execute", restoreJobArgs(runA, 55402)))
	info, err := os.Lstat(scratch + "/" + runA)
	if err != nil || info.Mode().Perm() != 0o700 || ownerOf(info) != b.uid {
		t.Fatalf("scratch %v %v", info, err)
	}
	start := b.run.find(SystemdRun, "--unit=")[0]
	if !strings.Contains(strings.Join(start.Args, " "), "--property=ReadWritePaths="+scratch+"/"+runA+" ") ||
		!strings.Contains(strings.Join(start.Args, " "), "--property=MemoryMax=4G --property=RuntimeMaxSec=86400") {
		t.Fatalf("%v", start.Args)
	}
	rec := b.record(runA)
	if rec.Purpose != "restore" || rec.ScratchDirectory != scratch+"/"+runA || len(rec.RowCounts) != 1 {
		t.Fatalf("%+v", rec)
	}
	// Reverification of the restore's scratch, while the restore runs:
	// refused; after it ended: a run on the same scratch.
	b.setUnit(rec.Unit, "active")
	reverify := canon.Object{{Name: "runId", Value: canon.String(runA)}, {Name: "verifyRunId", Value: canon.String(runB)},
		{Name: "port", Value: canon.Number(55403)}, {Name: "checks", Value: canon.Array{canon.String("probe_simple")}}}
	b.mustRefuse(OpRestoreVerify, b.job("restore.verify", reverify), CodePreconditionFailed)
	b.setUnit(rec.Unit, "failed")
	r := b.mustCall(OpRestoreVerify, b.job("restore.verify", reverify))
	if str(r, "runId") != runB {
		t.Fatalf("%v", r)
	}
	if v := b.record(runB); v.Purpose != "reverify" || v.ScratchDirectory != rec.ScratchDirectory || v.ScratchRunID != runA {
		t.Fatalf("%+v", v)
	}
}

func TestRestorePrepare(t *testing.T) {
	b := newBackupEnv(t)
	args := restoreJobArgs(runA, 55402)
	prepare := canon.Object{args[0], args[1], args[2], args[3], args[4]}
	r := b.mustCall(OpRestorePrepare, b.job("restore.prepare", prepare))
	if err := b.h.Schema.ValidateResult("restore.prepare@1", r); err != nil {
		t.Fatal(err)
	}
	got, _ := canon.Canonicalize(r)
	port, _ := r.Get("port")
	ecr, _ := r.Get("engineCanRead")
	req, _ := r.Get("spaceRequiredBytes")
	if port != canon.Number(55400) || ecr != canon.Bool(true) || req != canon.Number(23176062) || len(list(r, "refusals")) != 0 {
		t.Fatalf("%s", got)
	}
	// The engine read runs as the engine user.
	reads := b.run.find(SystemdRun, "--wait")
	if len(reads) != 1 || !strings.Contains(strings.Join(reads[0].Args, " "), fmt.Sprintf("--property=User=%d", b.uid)) {
		t.Fatalf("%v", reads)
	}
	// Another cluster's stanza.
	b.info = pgbrInfoFixture("42")
	r = b.mustCall(OpRestorePrepare, b.job("restore.prepare", prepare))
	if !hasString(list(r, "refusals"), "system_identifier_mismatch") {
		t.Fatalf("%v", r)
	}
	b.info = pgbrInfoFixture(sysid)
	// A label the catalog does not have; a target before every backup.
	labelled := restoreJobArgs(runA, 55402)
	labelled[4].Value.(canon.Object)[0].Value = canon.String("20261001-010000F")
	r = b.mustCall(OpRestorePrepare, b.job("restore.prepare", canon.Object{labelled[0], labelled[1], labelled[2], labelled[3], labelled[4]}))
	if !hasString(list(r, "refusals"), "label_not_found") {
		t.Fatalf("%v", r)
	}
	early := restoreJobArgs(runA, 55402)
	early[4].Value.(canon.Object)[1].Value = canon.String("2026-10-01T00:00:00Z")
	r = b.mustCall(OpRestorePrepare, b.job("restore.prepare", canon.Object{early[0], early[1], early[2], early[3], early[4]}))
	if !hasString(list(r, "refusals"), "target_outside_window") {
		t.Fatalf("%v", r)
	}
	// The scratch directory exists.
	if err := os.MkdirAll(b.root+"/var/lib/exponetdb-node-engine/scratch/"+runA, 0o700); err != nil {
		t.Fatal(err)
	}
	r = b.mustCall(OpRestorePrepare, b.job("restore.prepare", prepare))
	if !hasString(list(r, "refusals"), "scratch_exists") {
		t.Fatalf("%v", r)
	}
	// The engine cannot read the repository.
	b.info = `not json`
	r = b.mustCall(OpRestorePrepare, b.job("restore.prepare", prepare))
	if !hasString(list(r, "refusals"), "engine_cannot_read") {
		t.Fatalf("%v", r)
	}
	if err := b.h.Schema.ValidateResult("restore.prepare@1", r); err != nil {
		t.Fatal(err)
	}
}

func hasString(a canon.Array, s string) bool {
	for _, v := range a {
		if v == canon.String(s) {
			return true
		}
	}
	return false
}

func TestBackupList(t *testing.T) {
	b := newBackupEnv(t)
	listArgs := canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: pgbrRepo()}}
	r := b.mustCall(OpBackupList, b.job("backup.list", listArgs))
	if err := b.h.Schema.ValidateResult("backup.list@1", r); err != nil {
		t.Fatal(err)
	}
	got, _ := canon.Canonicalize(r)
	for _, want := range []string{`"engineVersion":"2.60.0"`, `"systemIdentifier":"` + sysid + `"`, `"cipher":"aes-256-cbc"`,
		`"kind":"differential"`, `"kind":"incremental"`, `"lsnStart":"0/2000028"`, `"walStart":"000000010000000000000002"`,
		`"startedAt":"2026-10-05T01:00:00Z"`, `"postgresMajor":17`, `"id":"17-1"`, `"truncated":false`} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("%s lacks %s", got, want)
		}
	}
	read := b.run.find(SystemdRun, "--wait")[0]
	want := "--config=" + b.root + "/etc/pgbackrest/pgbackrest.conf --stanza=main --repo=1 --output=json --log-level-console=off --log-level-stderr=off info"
	if !strings.HasSuffix(strings.Join(read.Args, " "), PgBackRest+" "+want) {
		t.Fatalf("%v", read.Args)
	}
	noSecrets(t, "argv", b.allArgv())
	// A failed engine read is an error, never an empty list.
	b.info = "[]"
	b.mustRefuse(OpBackupList, b.job("backup.list", listArgs), CodeFailed)
	// restic: the provisioned directory, secrets only in files.
	dir := b.root + "/etc/exponetdb-node/repositories/" + repoID
	writeFile(t, dir+"/repository", "s3:https://objects.example.test/bucket/prefix\n", 0o600)
	writeFile(t, dir+"/password", resticPass, 0o600)
	writeFile(t, dir+"/env", "AWS_ACCESS_KEY_ID=AKIDEXAMPLE\nAWS_SECRET_ACCESS_KEY="+awsSecret+"\n", 0o600)
	r = b.mustCall(OpBackupList, b.job("backup.list", canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: resticRepo()}}))
	if err := b.h.Schema.ValidateResult("backup.list@1", r); err != nil {
		t.Fatal(err)
	}
	got, _ = canon.Canonicalize(r)
	if !strings.Contains(string(got), `"kind":"logical"`) || !strings.Contains(string(got), `"startedAt":"2026-10-26T10:00:00.123Z"`) {
		t.Fatalf("%s", got)
	}
	noSecrets(t, "argv", b.allArgv())
	// The read's private files are gone.
	if entries, _ := os.ReadDir(b.root + "/var/lib/exponetdb-node-engine/reads"); len(entries) != 0 {
		t.Fatalf("read files left: %v", entries)
	}
	// An env file with a variable outside the allowlist: refused.
	writeFile(t, dir+"/env", "LD_PRELOAD=/tmp/x.so\n", 0o600)
	b.mustRefuse(OpBackupList, b.job("backup.list", canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: resticRepo()}}), CodePreconditionFailed)
	// A password file others can read: refused.
	writeFile(t, dir+"/env", "", 0o600)
	writeFile(t, dir+"/password", resticPass, 0o644)
	b.mustRefuse(OpBackupList, b.job("backup.list", canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: resticRepo()}}), CodePreconditionFailed)
}

func TestBackupTimers(t *testing.T) {
	b := newBackupEnv(t)
	b.run.fn = func(c Command) (Output, error) {
		switch {
		case c.Args[0] == "list-units":
			return Output{Stdout: []byte("pgbackrest-diff.timer loaded active waiting x\nlogrotate.timer loaded active waiting y\nnightly.timer loaded active waiting z\n")}, nil
		case strings.Contains(strings.Join(c.Args, " "), "NextElapseUSecRealtime"):
			return Output{Stdout: []byte("Id=logrotate.timer\nUnit=logrotate.service\nNextElapseUSecRealtime=@1793000000\nLastTriggerUSec=@1792000000\n\n" +
				"Id=nightly.timer\nUnit=db-backup.service\nNextElapseUSecRealtime=@1793000000\nLastTriggerUSec=n/a\n\n" +
				"Id=pgbackrest-diff.timer\nUnit=pgbackrest-diff.service\nNextElapseUSecRealtime=@1793000000\nLastTriggerUSec=@1792000000\n\n")}, nil
		case strings.Contains(strings.Join(c.Args, " "), "Id,Result"):
			return Output{Stdout: []byte("Id=pgbackrest-diff.service\nResult=success\n\nId=db-backup.service\nResult=success\n\n")}, nil
		}
		return Output{}, nil
	}
	r := b.mustCall(OpBackupTimers, b.job("backup.timers", canon.Object{}))
	if err := b.h.Schema.ValidateResult("backup.timers@1", r); err != nil {
		t.Fatal(err)
	}
	got, _ := canon.Canonicalize(r)
	want := `{"timers":[{"activates":"db-backup.service","lastAt":null,"lastResult":null,"nextAt":"2026-10-26T07:33:20Z","unit":"nightly.timer"},` +
		`{"activates":"pgbackrest-diff.service","lastAt":"2026-10-14T17:46:40Z","lastResult":"success","nextAt":"2026-10-26T07:33:20Z","unit":"pgbackrest-diff.timer"}]}`
	if string(got) != want {
		t.Fatalf("%s", got)
	}
	for _, c := range b.run.calls {
		if c.Args[0] != "list-units" && c.Args[0] != "show" {
			t.Fatalf("timers changed something: %v", c.Args)
		}
	}
}

func TestRestoreDiscard(t *testing.T) {
	b := newBackupEnv(t)
	discard := func(run string) canon.Object {
		r := b.mustCall(OpRestoreDiscard, b.job("restore.discard", canon.Object{{Name: "runId", Value: canon.String(run)}}))
		if err := b.h.Schema.ValidateResult("restore.discard@1", r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	if r := discard(runA); boolOf(r, "removed") {
		t.Fatalf("%v", r)
	}
	b.mustCall(OpRestoreExecute, b.job("restore.execute", restoreJobArgs(runA, 55402)))
	scratch := b.root + "/var/lib/exponetdb-node-engine/scratch/" + runA
	writeFile(t, scratch+"/base/1/1234", "data", 0o600)
	writeFile(t, scratch+"/PG_VERSION", "17\n", 0o600)
	writeFile(t, scratch+"/postmaster.pid", "1\n", 0o600)
	outside := b.root + "/precious"
	writeFile(t, outside+"/keep", "keep", 0o600)
	if err := os.Symlink(outside, scratch+"/pg_tblspc_link"); err != nil {
		t.Fatal(err)
	}
	// While the restore's unit runs: refused.
	b.setUnit(UnitName(runA), "active")
	b.mustRefuse(OpRestoreDiscard, b.job("restore.discard", canon.Object{{Name: "runId", Value: canon.String(runA)}}), CodePreconditionFailed)
	b.setUnit(UnitName(runA), "failed")
	r := discard(runA)
	if !boolOf(r, "removed") || boolOf(r, "wasRunning") {
		t.Fatalf("%v", r)
	}
	if _, err := os.Lstat(scratch); !os.IsNotExist(err) {
		t.Fatal("the scratch directory is still there")
	}
	if data, err := os.ReadFile(outside + "/keep"); err != nil || string(data) != "keep" {
		t.Fatal("the removal followed a symlink")
	}
	// The status of a stopped cluster was asked as the engine user (when the
	// test runs as root; otherwise the test user owns everything).
	if ctl := b.run.find(SystemdRun, "pg_ctl status -D "+scratch); len(ctl) != 1 && b.uid != b.h.rootUID() {
		t.Fatalf("%v", ctl)
	}
	if r := discard(runA); boolOf(r, "removed") {
		t.Fatalf("idempotent: %v", r)
	}
}

func boolOf(o canon.Object, name string) bool {
	v, _ := o.Get(name)
	return v == canon.Bool(true)
}

func list(o canon.Object, name string) canon.Array {
	v, _ := o.Get(name)
	a, _ := v.(canon.Array)
	return a
}

func TestLogicalBackupSecretsStayInFiles(t *testing.T) {
	b := newBackupEnv(t)
	b.mode(ModeOwned)
	dir := b.root + "/etc/exponetdb-node/repositories/" + repoID
	writeFile(t, dir+"/repository", "s3:https://objects.example.test/bucket\n", 0o600)
	writeFile(t, dir+"/password", resticPass, 0o600)
	writeFile(t, dir+"/env", "AWS_SECRET_ACCESS_KEY="+awsSecret+"\n", 0o600)
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runA, "logical", resticRepo())), CodePreconditionFailed)
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runA, "full", resticRepo())), CodePreconditionFailed)
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runA, "logical", resticRepo(), "app", "other_db")))
	noSecrets(t, "argv", b.allArgv())
	sec := b.runsRoot() + "/" + runA + "/work/secrets"
	private := b.runsRoot() + "/" + runA + "/private"
	for name, want := range map[string]os.FileMode{"password": 0o600, "repository": 0o600, "env": 0o600} {
		path := sec + "/" + name
		if name == "env" {
			path = private + "/env"
		}
		info, err := os.Lstat(path)
		if err != nil || info.Mode().Perm() != want {
			t.Fatalf("%s: %v %v", name, info, err)
		}
		owner := b.uid
		if name == "env" {
			owner = b.h.rootUID()
		}
		if ownerOf(info) != owner {
			t.Fatalf("%s is owned by %d", name, ownerOf(info))
		}
	}
	start := strings.Join(b.run.find(SystemdRun, "--unit=")[0].Args, " ")
	// The environment file lies in root's private directory, never in one
	// the engine user owns (B-5).
	if info, err := os.Lstat(private); err != nil || info.Mode().Perm() != 0o700 || ownerOf(info) != b.h.rootUID() {
		t.Fatalf("private %v %v", info, err)
	}
	if _, err := os.Lstat(sec + "/env"); !os.IsNotExist(err) {
		t.Fatal("an environment file in the engine user's directory")
	}
	if !strings.Contains(start, "--property=EnvironmentFile="+private+"/env") {
		t.Fatalf("%s", start)
	}
	// engine-run: pg_dump per database, pg_restore --list, the globals, then
	// restic with the password in a file and the credential in the
	// environment of restic only.
	fx := &fakeExec{fn: func(c engineCmd) (int, string) {
		if c.Path == Restic {
			return 0, `{"message_type":"status","percent_done":0.5,"bytes_done":10}` + "\n" + `{"message_type":"summary","snapshot_id":"` + strings.Repeat("cd", 32) + `"}` + "\n"
		}
		return 0, ""
	}}
	t.Setenv("AWS_SECRET_ACCESS_KEY", awsSecret)
	t.Setenv("LD_PRELOAD", "/tmp/evil.so")
	b.engine(runA, fx, context.Background())
	got := fx.argv()
	wantPrefix := []string{
		b.root + "/usr/lib/postgresql/17/bin/pg_dump --format=custom --host=" + b.root + "/run/postgresql --port=5432 --no-password --file=" + b.runsRoot() + "/" + runA + "/work/dump/app.dump --dbname=app",
		b.root + "/usr/lib/postgresql/17/bin/pg_restore --list " + b.runsRoot() + "/" + runA + "/work/dump/app.dump",
	}
	for i, w := range wantPrefix {
		if got[i] != w {
			t.Fatalf("argv %d:\n%s\nwant\n%s", i, got[i], w)
		}
	}
	last := fx.cmds[len(fx.cmds)-1]
	if last.Path != Restic || strings.Join(last.Args, " ") != "backup --json --no-cache --tag exponetdb --tag run:"+runA+" "+b.runsRoot()+"/"+runA+"/work/dump" {
		t.Fatalf("%v", last)
	}
	env := strings.Join(last.Env, "\n")
	if !strings.Contains(env, "RESTIC_PASSWORD_FILE="+sec+"/password") || !strings.Contains(env, "AWS_SECRET_ACCESS_KEY=") ||
		strings.Contains(env, "LD_PRELOAD") || strings.Contains(env, resticPass) {
		t.Fatalf("restic env %v", last.Env)
	}
	for _, c := range fx.cmds[:len(fx.cmds)-1] {
		if strings.Contains(strings.Join(c.Env, " "), awsSecret) {
			t.Fatal("a non-restic engine got the credential")
		}
	}
	b.setUnit(UnitName(runA), "")
	st := b.status(b.record(runA))
	out, _ := canon.Canonicalize(st)
	if str(st, "state") != "succeeded" || !strings.Contains(string(out), strings.Repeat("cd", 32)) || !strings.Contains(string(out), `"percent":50`) {
		t.Fatalf("%s", out)
	}
	// The secrets and the dumps are gone.
	for _, p := range []string{sec, b.runsRoot() + "/" + runA + "/work/dump"} {
		if _, err := os.Lstat(p); !os.IsNotExist(err) {
			t.Fatalf("%s left", p)
		}
	}
}

// ----- engine-run -----

type fakeExec struct {
	mu    sync.Mutex
	cmds  []engineCmd
	fn    func(c engineCmd) (int, string)
	block func(c engineCmd) bool
}

func (f *fakeExec) run(ctx context.Context, c engineCmd) (int, error) {
	f.mu.Lock()
	f.cmds = append(f.cmds, c)
	f.mu.Unlock()
	if f.block != nil && f.block(c) {
		<-ctx.Done()
		return -1, ctx.Err()
	}
	code, out := 0, ""
	if f.fn != nil {
		code, out = f.fn(c)
	}
	if c.Out != nil {
		_, _ = c.Out.Write([]byte(out))
	}
	return code, nil
}

func (f *fakeExec) start(c engineCmd) (engineProc, error) {
	f.mu.Lock()
	f.cmds = append(f.cmds, c)
	f.mu.Unlock()
	return nil, fmt.Errorf("no postgres in unit tests")
}

func (f *fakeExec) argv() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.cmds {
		out = append(out, c.Path+" "+strings.Join(c.Args, " "))
	}
	return out
}

func (b *benv) engine(run string, fx *fakeExec, ctx context.Context) {
	b.t.Helper()
	if err := EngineRun(ctx, EngineOptions{RunsRoot: b.runsRoot(), RunID: run, RecordOwner: b.h.rootUID(), exec: fx, skipChecks: true}); err != nil {
		b.t.Fatal(err)
	}
}

func TestEngineRunPgBackRestBackup(t *testing.T) {
	b := newBackupEnv(t)
	b.mode(ModeAdoptedRuns)
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runA, "incremental", pgbrRepo())))
	fx := &fakeExec{fn: func(c engineCmd) (int, string) {
		if strings.HasSuffix(strings.Join(c.Args, " "), " info") {
			return 0, pgbrInfoFixture(sysid)
		}
		return 0, "INFO: backup command begin 2.60.0: --repo1-cipher-pass=" + cipherPass + " --stanza=main\n" +
			"INFO: new backup label = 20261007-010000F_20261007-120000I\nINFO: backup command end: completed successfully\n"
	}}
	b.engine(runA, fx, context.Background())
	conf := b.root + "/etc/pgbackrest/pgbackrest.conf"
	// First the stanza's identity (B-2), then the backup.
	if got := fx.argv(); len(got) != 2 || !strings.HasSuffix(got[0], " info") ||
		got[1] != PgBackRest+" --config="+conf+" --stanza=main --repo=1 --no-expire-auto --type=incr --log-level-console=info backup" {
		t.Fatalf("%v", got)
	}
	if len(fx.cmds[1].Env) != 0 {
		t.Fatalf("pgBackRest got an environment: %v", fx.cmds[1].Env)
	}
	st := b.status(b.record(runA))
	out, _ := canon.Canonicalize(st)
	noSecrets(t, "status", string(out))
	if str(st, "state") != "succeeded" || !strings.Contains(string(out), `"label":"20261007-010000F_20261007-120000I"`) {
		t.Fatalf("%s", out)
	}
}

func TestEngineRunExpireKeepsLabels(t *testing.T) {
	b := newBackupEnv(t)
	b.mode(ModeOwned)
	expire := func(run string, full int, diff canon.Value, keep ...string) {
		k := canon.Array{}
		for _, l := range keep {
			k = append(k, canon.String(l))
		}
		b.mustCall(OpBackupExpire, b.job("backup.expire", canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: pgbrRepo()},
			{Name: "runId", Value: canon.String(run)},
			{Name: "retention", Value: canon.Object{{Name: "fullCount", Value: canon.Number(full)}, {Name: "differentialCount", Value: diff}, {Name: "logicalDays", Value: canon.Null{}}}},
			{Name: "keepLabels", Value: k}}))
	}
	info := func(c engineCmd) (int, string) {
		if strings.HasSuffix(strings.Join(c.Args, " "), " info") {
			return 0, pgbrInfoFixture(sysid)
		}
		return 0, "INFO: expire command end: completed successfully\n"
	}
	// fullCount 1 keeps only the newest full and its children: the older
	// full is kept by the plan, so the expiry is refused before it runs.
	expire(runA, 1, canon.Null{}, "20261005-010000F")
	fx := &fakeExec{fn: info}
	b.engine(runA, fx, context.Background())
	if len(fx.cmds) != 1 {
		t.Fatalf("the expiry ran: %v", fx.argv())
	}
	b.setUnit(UnitName(runA), "")
	if st := b.status(b.record(runA)); str(st, "state") != "failed" || !strings.Contains(str(st, "excerpt"), "refused") {
		t.Fatalf("%v", st)
	}
	// An incremental resting on a differential: unknown without a
	// differential retention, so refused too.
	expire(runB, 1, canon.Null{}, "20261006-010000F_20261006-030000I")
	fx = &fakeExec{fn: info}
	b.engine(runB, fx, context.Background())
	if len(fx.cmds) != 1 {
		t.Fatalf("the expiry ran: %v", fx.argv())
	}
	// With the differential kept, it runs with a count-type retention.
	b.setUnit(UnitName(runB), "")
	b.status(b.record(runB))
	expire(runC, 1, canon.Number(1), "20261006-010000F_20261006-030000I", "20261006-010000F")
	fx = &fakeExec{fn: info}
	b.engine(runC, fx, context.Background())
	got := fx.argv()
	if len(got) != 4 || !strings.HasSuffix(got[1], "--repo1-retention-diff=1 --dry-run --log-level-console=info expire") ||
		!strings.HasSuffix(got[2], "--repo1-retention-full-type=count --repo1-retention-full=1 --repo1-retention-diff=1 --log-level-console=info expire") ||
		!strings.HasSuffix(got[3], " info") {
		t.Fatalf("%v", got)
	}
	b.setUnit(UnitName(runC), "")
	if st := b.status(b.record(runC)); str(st, "state") != "succeeded" {
		t.Fatalf("%v", st)
	}
}

// TestEngineRunExpireRace (B-3): the engine's dry run names a kept label:
// refused before anything changes; a kept label gone after the expiry (a
// backup completed meanwhile): failed, with the reason.
func TestEngineRunExpireRace(t *testing.T) {
	b := newBackupEnv(t)
	b.mode(ModeOwned)
	expire := func(run string, keep string) {
		b.mustCall(OpBackupExpire, b.job("backup.expire", canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: pgbrRepo()},
			{Name: "runId", Value: canon.String(run)},
			{Name: "retention", Value: canon.Object{{Name: "fullCount", Value: canon.Number(2)}, {Name: "differentialCount", Value: canon.Null{}}, {Name: "logicalDays", Value: canon.Null{}}}},
			{Name: "keepLabels", Value: canon.Array{canon.String(keep)}}}))
	}
	expire(runA, "20261005-010000F")
	fx := &fakeExec{fn: func(c engineCmd) (int, string) {
		args := strings.Join(c.Args, " ")
		switch {
		case strings.HasSuffix(args, " info"):
			return 0, pgbrInfoFixture(sysid)
		case strings.Contains(args, "--dry-run"):
			return 0, "INFO: [DRY-RUN] repo1: expire full backup set 20261005-010000F, 20261005-010000F_20261005-020000I\n"
		}
		return 0, ""
	}}
	b.engine(runA, fx, context.Background())
	if len(fx.cmds) != 2 {
		t.Fatalf("the expiry ran: %v", fx.argv())
	}
	b.setUnit(UnitName(runA), "")
	if st := b.status(b.record(runA)); str(st, "state") != "failed" || !strings.Contains(str(st, "excerpt"), "would expire kept backup") {
		t.Fatalf("%v", st)
	}
	// An incremental of a kept full in the dry run is not the full.
	expire(runB, "20261006-010000F")
	infos := 0
	fx = &fakeExec{fn: func(c engineCmd) (int, string) {
		args := strings.Join(c.Args, " ")
		switch {
		case strings.HasSuffix(args, " info"):
			infos++
			if infos == 2 {
				// A newer full pushed the kept one out meanwhile.
				return 0, strings.Replace(pgbrInfoFixture(sysid), `"label":"20261006-010000F"`, `"label":"20261007-010000F"`, 1)
			}
			return 0, pgbrInfoFixture(sysid)
		case strings.Contains(args, "--dry-run"):
			return 0, "INFO: [DRY-RUN] repo1: expire diff backup set 20261006-010000F_20261006-020000D\n"
		}
		return 0, "INFO: expire command end: completed successfully\n"
	}}
	b.engine(runB, fx, context.Background())
	if len(fx.cmds) != 4 {
		t.Fatalf("%v", fx.argv())
	}
	b.setUnit(UnitName(runB), "")
	if st := b.status(b.record(runB)); str(st, "state") != "failed" || !strings.Contains(str(st, "excerpt"), "is gone after the expiry") {
		t.Fatalf("%v", st)
	}
}

func TestEngineRunCancelBeforeAndAfterTheEffect(t *testing.T) {
	b := newBackupEnv(t)
	b.mode(ModeOwned)
	b.mustCall(OpBackupExpire, b.job("backup.expire", canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: pgbrRepo()},
		{Name: "runId", Value: canon.String(runA)},
		{Name: "retention", Value: canon.Object{{Name: "fullCount", Value: canon.Number(2)}, {Name: "differentialCount", Value: canon.Null{}}, {Name: "logicalDays", Value: canon.Null{}}}},
		{Name: "keepLabels", Value: canon.Array{}}}))
	// Stopped while it reads the catalog: nothing changed, canceled.
	ctx, cancel := context.WithCancel(context.Background())
	fx := &fakeExec{block: func(c engineCmd) bool { cancel(); return true }}
	b.engine(runA, fx, ctx)
	b.setUnit(UnitName(runA), "")
	if st := b.status(b.record(runA)); str(st, "state") != "canceled" {
		t.Fatalf("%v", st)
	}
	// Stopped while the backup runs: failed, never canceled.
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runB, "full", pgbrRepo())))
	ctx, cancel = context.WithCancel(context.Background())
	fx = &fakeExec{fn: func(engineCmd) (int, string) { return 0, pgbrInfoFixture(sysid) },
		block: func(c engineCmd) bool {
			if c.Args[len(c.Args)-1] != "backup" {
				return false
			}
			cancel()
			return true
		}}
	b.engine(runB, fx, ctx)
	b.setUnit(UnitName(runB), "")
	if st := b.status(b.record(runB)); str(st, "state") != "failed" || !strings.Contains(str(st, "excerpt"), "after the engine began") {
		t.Fatalf("%v", st)
	}
}

func TestEngineRunRestoreRefusesAnotherStanza(t *testing.T) {
	b := newBackupEnv(t)
	b.mustCall(OpRestoreExecute, b.job("restore.execute", restoreJobArgs(runA, 55402)))
	fx := &fakeExec{fn: func(c engineCmd) (int, string) { return 0, pgbrInfoFixture("42") }}
	b.engine(runA, fx, context.Background())
	if len(fx.cmds) != 1 {
		t.Fatalf("restored another cluster's stanza: %v", fx.argv())
	}
	b.setUnit(UnitName(runA), "")
	st := b.status(b.record(runA))
	if str(st, "state") != "canceled" && str(st, "state") != "failed" {
		t.Fatalf("%v", st)
	}
	if !strings.Contains(str(st, "excerpt"), "another cluster") {
		t.Fatalf("%v", st)
	}
	// The record's arguments are checked again: a tampered record (another
	// run's arguments) is refused by engine-run.
	b.mustCall(OpRestoreExecute, b.job("restore.execute", restoreJobArgs(runB, 55403)))
	path := b.runsRoot() + "/" + runB + "/record.json"
	data, _ := os.ReadFile(path)
	if err := os.WriteFile(path, []byte(strings.Replace(string(data), `"runId":"`+runB+`","target"`, `"runId":"`+runC+`","target"`, 1)), 0o640); err != nil {
		t.Fatal(err)
	}
	fx = &fakeExec{}
	b.engine(runB, fx, context.Background())
	if len(fx.cmds) != 0 {
		t.Fatalf("a tampered record ran: %v", fx.argv())
	}
}

func TestRestoreTypeArgs(t *testing.T) {
	label, at, lsn, tl := "20261006-010000F", "2026-10-06T02:30:00.5Z", "0/6000120", int64(2)
	for _, c := range []struct {
		t    restoreTarget
		want string
	}{
		{restoreTarget{Time: &at, Timeline: &tl}, "--type=time --target=2026-10-06 02:30:00.5+00 --target-action=promote --target-timeline=2"},
		{restoreTarget{Lsn: &lsn}, "--type=lsn --target=0/6000120 --target-action=promote"},
		{restoreTarget{Label: &label}, "--type=immediate --target-action=promote --set=20261006-010000F"},
		{restoreTarget{}, "--type=default"},
	} {
		got, err := restoreTypeArgs(c.t)
		if err != nil || strings.Join(got, " ") != c.want {
			t.Fatalf("%v %v, want %s", got, err, c.want)
		}
	}
	bad := "1/x; rm -rf /"
	if _, err := restoreTypeArgs(restoreTarget{Lsn: &bad}); err == nil {
		t.Fatal("a bad LSN passed")
	}
}

func TestRedact(t *testing.T) {
	in := "INFO: --repo1-cipher-pass=" + cipherPass + " ok\nAWS_SECRET_ACCESS_KEY=" + awsSecret + "\npassword: hunter2\n" +
		"s3://user:" + resticPass + "@host/bucket\nkey " + strings.Repeat("Q", 48) + "\nlabel 20261006-010000F_20261006-030000I lsn 0/6000120\x1b[0m"
	out := Redact(in, 2048)
	noSecrets(t, "redacted", out)
	if strings.Contains(out, "hunter2") || !strings.Contains(out, "20261006-010000F_20261006-030000I") || !strings.Contains(out, "0/6000120") ||
		strings.ContainsRune(out, 0x1b) {
		t.Fatalf("%q", out)
	}
	long := strings.Repeat("line of output\n", 1000)
	if got := Redact(long, 2048); len(got) > 2048 || !strings.HasSuffix(got, "line of output") {
		t.Fatalf("%d", len(got))
	}
}

func TestSurvivors(t *testing.T) {
	s, err := parsePgbrInfo([]byte(pgbrInfoFixture(sysid)), "main")
	if err != nil {
		t.Fatal(err)
	}
	two := pgbrSurvivors(s, 2, nil)
	if !two["20261005-010000F"] || !two["20261005-010000F_20261005-020000I"] || !two["20261006-010000F"] || two["20261006-010000F_20261006-030000I"] {
		t.Fatalf("%v", two)
	}
	one, d := pgbrSurvivors(s, 1, nil), 0
	if one["20261005-010000F"] || !one["20261006-010000F"] {
		t.Fatalf("%v", one)
	}
	none := pgbrSurvivors(s, 1, &d)
	if none["20261006-010000F_20261006-020000D"] || !none["20261006-010000F"] {
		t.Fatalf("%v", none)
	}
}

func TestRemoveAllStaysInside(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root+"/scratch/r/a/b/c", "x", 0o600)
	writeFile(t, root+"/outside/f", "keep", 0o600)
	if err := os.Symlink(root+"/outside", root+"/scratch/r/a/link"); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(root+"/scratch/r/fifo", 0o600); err != nil {
		t.Fatal(err)
	}
	d, err := fsafe.OpenDir(root + "/scratch")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if removed, err := d.RemoveAll(context.Background(), "r"); err != nil || !removed {
		t.Fatal(removed, err)
	}
	if _, err := os.Stat(root + "/outside/f"); err != nil {
		t.Fatal("followed a symlink")
	}
}

func TestOutcomeShapes(t *testing.T) {
	// Every outcome the engine may write is reported within the contract.
	for _, raw := range []string{`{}`, `[]`, `{"schema":"exponetdb.engine-outcome/v1","state":"succeeded","exitCode":300,"finishedAt":"x","excerpt":"","label":"../../x",` +
		`"verifyErrors":-1,"recoveryReachedLsn":"0/1","recoveryReachedAt":"2026-10-07T12:00:00+02:00","timeline":1,"port":55400,` +
		`"checks":[{"check":"amcheck","outcome":"passed","detail":"` + strings.Repeat("x", 4000) + `"}],"phases":[{"name":"restore","startedAt":"2026-10-07T12:00:00Z","finishedAt":null,"outcome":"running"}]}`} {
		checkOutcome(t, raw)
	}
}

func checkOutcome(t *testing.T, raw string) {
	b := newBackupEnv(t)
	b.mode(ModeOwned)
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())))
	writeFile(t, b.runsRoot()+"/"+runA+"/work/outcome.json", raw, 0o600)
	writeFile(t, b.runsRoot()+"/"+runA+"/work/progress.json", `{"percent":500,"bytes":-3}`, 0o600)
	b.setUnit(UnitName(runA), "")
	b.status(b.record(runA))
}

// FuzzEngineOutputs: whatever the engines print or engine-run writes, the
// node reports it within the contract (or refuses), never passes it through.
func FuzzEngineOutputs(f *testing.F) {
	f.Add([]byte(`[{"name":"main","cipher":"none","status":{"code":0,"message":"ok"},"db":[{"id":1,"system-id":7,"version":"17"}],`+
		`"archive":[{"id":"17-1","min":"000000010000000000000001","max":null}],"backup":[{"label":"20261005-010000F","type":"full","error":false,`+
		`"archive":{"start":"000000010000000000000002"},"database":{"id":1},"info":{"size":1,"repository":{"size":1}},"lsn":{"start":"0/1","stop":"0/2"},`+
		`"prior":null,"timestamp":{"start":1,"stop":2}}]}]`), []byte(`{"schema":"exponetdb.engine-outcome/v1","state":"succeeded","exitCode":0,"finishedAt":"2026-10-07T12:00:00Z","excerpt":"x","label":"20261007-120000F","verifyErrors":0,"recoveryReachedLsn":"0/1","recoveryReachedAt":null,"timeline":2,"port":55400,"checks":[],"phases":[]}`))
	f.Add([]byte(`[{"time":"2026-10-26T12:00:00Z","id":"abababab","summary":{"backup_end":"2026-10-26T12:01:00Z","total_bytes_processed":-1}}]`), []byte(`{}`))
	sv, err := schema.Protocol()
	if err != nil {
		f.Fatal(err)
	}
	f.Fuzz(func(t *testing.T, info, outcome []byte) {
		if len(info) > maxOutput || len(outcome) > 256*1024 {
			return
		}
		if s, err := parsePgbrInfo(info, "main"); err == nil {
			if err := sv.ValidateResult("backup.list@1", pgbrListResult(s, "2.60.0")); err != nil {
				t.Fatalf("pgBackRest list: %v", err)
			}
			_ = pgbrSurvivors(s, 1, nil)
		}
		if r, err := resticListResult(info, "0.16.4"); err == nil {
			if err := sv.ValidateResult("backup.list@1", r); err != nil {
				t.Fatalf("restic list: %v", err)
			}
		}
		var o runOutcome
		if decodeStrict(outcome, &o) != nil {
			return
		}
		state := o.State
		if !oneOf(state, "succeeded", "failed", "canceled") {
			state = "failed"
		}
		res := terminalResult(state, "", nil, Redact(o.Excerpt, 2048), nil, outcomeValue(&o))
		status := canon.Object{{Name: "runId", Value: canon.String(runA)}, {Name: "found", Value: canon.Bool(true)},
			{Name: "startJobId", Value: canon.String("job_01M60000000000000000000003")}, {Name: "startArgsHash", Value: canon.String("sha256:" + strings.Repeat("a", 64))},
			{Name: "purpose", Value: canon.String("backup")}, {Name: "startedAt", Value: canon.String("2026-10-07T12:00:00Z")}}
		for _, m := range res {
			status = append(status, m)
		}
		if err := sv.ValidateResult("run.status@1", status); err != nil {
			t.Fatalf("run.status: %v", err)
		}
	})
}

// TestRepositoryBinding (B-1): a repository id whose mode allows runs is
// bound by the host to one stanza and repo index; a job naming another one,
// or a repository without the binding, is refused before anything runs.
func TestRepositoryBinding(t *testing.T) {
	b := newBackupEnv(t)
	dir := b.root + "/etc/exponetdb-node/repositories/" + repoID
	b.mode(ModeOwned)
	other := pgbrRepo()
	other[3].Value = canon.Number(2)
	writeFile(t, b.root+"/etc/pgbackrest/pgbackrest.conf", "[global]\nrepo1-path=/var/lib/pgbackrest\nrepo2-path=/srv/observed\n\n[main]\npg1-path=/x\n", 0o640)
	// Another repo index of the same stanza: refused, whatever the mode says.
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runA, "full", other)), CodePreconditionFailed)
	expire := canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: other}, {Name: "runId", Value: canon.String(runA)},
		{Name: "retention", Value: canon.Object{{Name: "fullCount", Value: canon.Number(1)}, {Name: "differentialCount", Value: canon.Null{}}, {Name: "logicalDays", Value: canon.Null{}}}},
		{Name: "keepLabels", Value: canon.Array{}}}
	b.mustRefuse(OpBackupExpire, b.job("backup.expire", expire), CodePreconditionFailed)
	otherStanza := pgbrRepo()
	otherStanza[2].Value = canon.String("other")
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runA, "full", otherStanza)), CodePreconditionFailed)
	// No binding file while the mode allows runs: refused.
	_ = os.Remove(dir + "/pgbackrest")
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())), CodePreconditionFailed)
	// A malformed, duplicated or writable binding: refused.
	for _, bad := range []string{"stanza=main\n", "stanza=main\nrepo=1\nrepo=1\n", "stanza=main\nrepo=1\npath=/x\n", "stanza=main\nrepo=9\n", "stanza=ma in\nrepo=1\n"} {
		writeFile(t, dir+"/pgbackrest", bad, 0o644)
		b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())), CodePreconditionFailed)
	}
	writeFile(t, dir+"/pgbackrest", "stanza=main\nrepo=1\n", 0o666)
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())), CodePreconditionFailed)
	if len(b.run.find(SystemdRun, "--unit=")) != 0 {
		t.Fatal("a run started")
	}
	// The bound repository runs.
	writeFile(t, dir+"/pgbackrest", "# bound\nstanza = main\nrepo = 1\n", 0o644)
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())))
	// Observation needs no binding: no directory at all, or adopted_observed.
	_ = os.RemoveAll(dir)
	listArgs := canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: other}}
	b.mustCall(OpBackupList, b.job("backup.list", listArgs))
	b.mode(ModeAdoptedObserved)
	_ = os.Remove(dir + "/pgbackrest")
	b.mustCall(OpBackupList, b.job("backup.list", listArgs))
	// A binding that exists binds observation too.
	writeFile(t, dir+"/pgbackrest", "stanza=main\nrepo=1\n", 0o644)
	b.mustRefuse(OpBackupList, b.job("backup.list", listArgs), CodePreconditionFailed)
}

// TestStartsCheckTheStanzasCluster (B-2): every pgBackRest run checks the
// stanza's system identifier before it starts, and engine-run again before
// the engine runs.
func TestStartsCheckTheStanzasCluster(t *testing.T) {
	b := newBackupEnv(t)
	b.mode(ModeOwned)
	b.info = pgbrInfoFixture("42")
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())), CodePreconditionFailed)
	b.mustRefuse(OpBackupVerify, b.job("backup.verify", canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: pgbrRepo()},
		{Name: "runId", Value: canon.String(runA)}, {Name: "label", Value: canon.Null{}}, {Name: "snapshot", Value: canon.Null{}}}), CodePreconditionFailed)
	b.mustRefuse(OpBackupExpire, b.job("backup.expire", canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: pgbrRepo()},
		{Name: "runId", Value: canon.String(runA)},
		{Name: "retention", Value: canon.Object{{Name: "fullCount", Value: canon.Number(1)}, {Name: "differentialCount", Value: canon.Null{}}, {Name: "logicalDays", Value: canon.Null{}}}},
		{Name: "keepLabels", Value: canon.Array{}}}), CodePreconditionFailed)
	b.mustRefuse(OpRestoreExecute, b.job("restore.execute", restoreJobArgs(runA, 55402)), CodePreconditionFailed)
	// A stanza without a database (never created): refused too.
	b.info = `[{"name":"main","status":{"code":1,"message":"missing stanza path"},"db":[],"backup":[],"archive":[]}]`
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())), CodePreconditionFailed)
	if len(b.run.find(SystemdRun, "--unit=")) != 0 {
		t.Fatal("a run started")
	}
	// The stanza changed between the start and the run: engine-run refuses.
	b.info = pgbrInfoFixture(sysid)
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())))
	fx := &fakeExec{fn: func(c engineCmd) (int, string) { return 0, pgbrInfoFixture("42") }}
	b.engine(runA, fx, context.Background())
	if len(fx.cmds) != 1 {
		t.Fatalf("backed up another cluster's stanza: %v", fx.argv())
	}
	b.setUnit(UnitName(runA), "")
	if st := b.status(b.record(runA)); str(st, "state") == "succeeded" || !strings.Contains(str(st, "excerpt"), "another cluster") {
		t.Fatalf("%v", st)
	}
}

// TestConfDIsNamedToTheEngine (A-9): the conf.d directory the helper read
// is the one every engine command names; one others can write is refused.
func TestConfDIsNamedToTheEngine(t *testing.T) {
	b := newBackupEnv(t)
	b.mode(ModeOwned)
	confd := b.root + "/etc/pgbackrest/conf.d"
	writeFile(t, confd+"/10-lock.conf", "[global]\nlock-path=/run/pgbackrest-lock\n", 0o640)
	b.mustCall(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())))
	read := strings.Join(b.run.find(SystemdRun, "--wait")[0].Args, " ")
	if !strings.Contains(read, "--config="+b.root+"/etc/pgbackrest/pgbackrest.conf --config-include-path="+confd+" --stanza=main") {
		t.Fatalf("%s", read)
	}
	start := strings.Join(b.run.find(SystemdRun, "--unit=")[0].Args, " ")
	if !strings.Contains(start, "--property=ReadWritePaths=-/run/pgbackrest-lock") || strings.Contains(start, "BindPaths=-/tmp/pgbackrest") {
		t.Fatalf("the conf.d lock path is not the unit's: %s", start)
	}
	if rec := b.record(runA); rec.PgBackRest.Include != confd {
		t.Fatalf("%+v", rec.PgBackRest)
	}
	fx := &fakeExec{fn: func(c engineCmd) (int, string) {
		if strings.HasSuffix(strings.Join(c.Args, " "), " info") {
			return 0, pgbrInfoFixture(sysid)
		}
		return 0, ""
	}}
	b.engine(runA, fx, context.Background())
	for _, a := range fx.argv() {
		if !strings.Contains(a, "--config-include-path="+confd+" ") {
			t.Fatalf("an engine command without the include path: %s", a)
		}
	}
	// A conf.d others can write: refused.
	b.setUnit(UnitName(runA), "")
	if err := os.Chmod(confd, 0o777); err != nil {
		t.Fatal(err)
	}
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runB, "full", pgbrRepo())), CodePreconditionFailed)
}

// TestScratchStartNeutralizesTheRestoredServer (B-4, C-2): the restored
// postgresql.auto.conf is moved aside, only the recovery target is kept,
// and the postmaster's command line turns off libraries, workers,
// replication and the restored shell commands.
func TestScratchStartNeutralizesTheRestoredServer(t *testing.T) {
	b := newBackupEnv(t)
	b.mustCall(OpRestoreExecute, b.job("restore.execute", restoreJobArgs(runA, 55402)))
	scratch := b.root + "/var/lib/exponetdb-node-engine/scratch/" + runA
	restored := "shared_preload_libraries = 'evil'\nsession_preload_libraries = 'evil'\narchive_command = 'curl evil'\n" +
		"restore_command = 'curl evil'\nrecovery_target_time = '2026-10-06 02:30:00+00'\nrecovery_target_action = 'promote'\n" +
		"recovery_target_time = 'x'' ; include ''/etc/x'\ninclude '/tmp/evil.conf'\n"
	fx := &fakeExec{fn: func(c engineCmd) (int, string) {
		args := strings.Join(c.Args, " ")
		switch {
		case strings.HasSuffix(args, " info"):
			return 0, pgbrInfoFixture(sysid)
		case strings.HasSuffix(args, " restore"):
			writeFile(t, scratch+"/PG_VERSION", "17\n", 0o600)
			writeFile(t, scratch+"/postgresql.auto.conf", restored, 0o600)
		}
		return 0, ""
	}}
	b.engine(runA, fx, context.Background())
	auto, err := os.ReadFile(scratch + "/postgresql.auto.conf")
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"evil", "archive_command", "restore_command", "\ninclude"} {
		if strings.Contains(string(auto), bad) {
			t.Fatalf("the restored %q survived: %s", bad, auto)
		}
	}
	if !strings.Contains(string(auto), "recovery_target_time = '2026-10-06 02:30:00+00'") || !strings.Contains(string(auto), "recovery_target_action = 'promote'") {
		t.Fatalf("%s", auto)
	}
	if kept, _ := os.ReadFile(scratch + "/exponetdb-restored-postgresql.auto.conf"); string(kept) != restored {
		t.Fatal("the restored file was not kept as evidence")
	}
	var postmaster string
	for _, a := range fx.argv() {
		if strings.Contains(a, "/bin/postgres ") {
			postmaster = a
		}
	}
	conf := b.root + "/etc/pgbackrest/pgbackrest.conf"
	for _, want := range []string{"-c shared_preload_libraries= ", "-c session_preload_libraries= ", "-c local_preload_libraries= ",
		"-c dynamic_library_path=$libdir ", "-c max_logical_replication_workers=0 ", "-c max_worker_processes=0 ", "-c max_wal_senders=0 ",
		"-c autovacuum=off ", "-c event_triggers=off", "-c recovery_end_command= ", "-c archive_cleanup_command= ", "-c primary_conninfo= ",
		"-c listen_addresses= ", "-c archive_mode=off ", "-c hot_standby=off",
		"-c restore_command=" + PgBackRest + " --config=" + conf + " --stanza=main --repo=1 --pg1-path=" + scratch + " archive-get %f \"%p\""} {
		if !strings.Contains(postmaster+" ", want) {
			t.Fatalf("postmaster lacks %q: %s", want, postmaster)
		}
	}
	// A reverification fetches no WAL.
	e := &engineRun{rec: &runRecord{Purpose: "reverify", PostgresMajor: 16, PgBackRest: &recordPgbr{Config: conf, Stanza: "main", Repo: 1}}}
	if e.restoreCommand() != "" || strings.Contains(strings.Join(e.neutralizing(), " "), "event_triggers") {
		t.Fatalf("%v", e.neutralizing())
	}
	// A configuration path a shell would split is never put into the command.
	e = &engineRun{rec: &runRecord{Purpose: "restore", PostgresMajor: 17, PgBackRest: &recordPgbr{Config: "/etc/pg br/x.conf", Stanza: "main", Repo: 1}}}
	if e.restoreCommand() != "" {
		t.Fatal(e.restoreCommand())
	}
	// The check sessions load nothing and read only.
	if got := strings.Join((&engineRun{rec: &runRecord{PostgresMajor: 17}}).checkSettings(), " "); got !=
		"session_preload_libraries= local_preload_libraries= jit=off default_transaction_read_only=on event_triggers=off" {
		t.Fatal(got)
	}
}

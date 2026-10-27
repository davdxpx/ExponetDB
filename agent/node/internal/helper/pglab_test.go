//go:build pglab

package helper

// The backup and restore lab (Wave 9 Part B, ADR-0037): the real engines on
// this machine (pgBackRest, restic, PostgreSQL 17) against a disposable
// cluster, a disposable encrypted pgBackRest repository and a disposable
// restic repository, all in a temporary directory. It runs as root:
//
//	go test -tags pglab -count=1 -run TestPglab -v ./internal/helper/
//
// systemd is not available here: the supervisor runs each engine run as a
// direct child (this test binary, re-executed as the PostgreSQL user, runs
// the engine-run program), and the engine user's catalog reads as direct
// children too. The transient units, their properties and their behavior
// across a helper restart or a reboot are NOT PROVEN by this test.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/pgwire"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
)

const (
	childEnvRuns = "EXDB_PGLAB_ENGINE_RUNS"
	childEnvRun  = "EXDB_PGLAB_ENGINE_RUN"
	labPort      = 55390
	pubPort      = 55391
	labRepo      = "bkr_01M70000000000000000000001"
	labRestic    = "bkr_01M70000000000000000000002"
)

// TestPglabEngineChild is the engine-run program when this binary runs as a
// lab run's child (as systemd would run `exponetdb-node-helper engine-run`).
func TestPglabEngineChild(t *testing.T) {
	runs, run := os.Getenv(childEnvRuns), os.Getenv(childEnvRun)
	if runs == "" {
		t.Skip("only as a lab run's child")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := EngineRun(ctx, EngineOptions{RunsRoot: runs, RunID: run}); err != nil {
		t.Fatal(err)
	}
}

// directSupervisor runs runs and reads as direct children of the test.
type directSupervisor struct {
	binary string
	logDir string
	mu     sync.Mutex
	procs  map[string]*labProc
}

type labProc struct {
	done chan struct{}
	cmd  *exec.Cmd
	code int
}

func envFromFile(path string) []string {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []string
	for _, l := range strings.Split(string(data), "\n") {
		if strings.Contains(l, "=") {
			out = append(out, l)
		}
	}
	return out
}

func (d *directSupervisor) start(_ context.Context, u unitSpec) error {
	cmd := exec.Command(d.binary, "-test.run=^TestPglabEngineChild$", "-test.count=1")
	cmd.Env = append([]string{"PATH=/usr/bin:/bin", childEnvRuns + "=" + filepath.Dir(filepath.Dir(u.ReadWrite[0])), childEnvRun + "=" + u.RunID},
		envFromFile(u.EnvironmentFile)...)
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(u.UID), Gid: uint32(u.GID)}}
	logf, _ := os.Create(d.logDir + "/" + u.RunID + ".log")
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		return err
	}
	p := &labProc{done: make(chan struct{}), cmd: cmd}
	go func() {
		err := cmd.Wait()
		if exit, ok := err.(*exec.ExitError); ok {
			p.code = exit.ExitCode()
		}
		close(p.done)
	}()
	d.mu.Lock()
	d.procs[u.Unit] = p
	d.mu.Unlock()
	return nil
}

func (d *directSupervisor) states(_ context.Context, units []string) (map[string]unitState, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := map[string]unitState{}
	for _, u := range units {
		p := d.procs[u]
		if p == nil {
			out[u] = unitState{}
			continue
		}
		select {
		case <-p.done:
			if p.code == 0 {
				out[u] = unitState{} // a succeeded transient unit is collected
			} else {
				c := p.code
				out[u] = unitState{Loaded: true, ActiveText: "failed", Result: "exit-code", ExitStatus: &c}
			}
		default:
			out[u] = unitState{Loaded: true, Active: true, ActiveText: "active"}
		}
	}
	return out, nil
}

func (d *directSupervisor) stop(_ context.Context, unit string) error {
	d.mu.Lock()
	p := d.procs[unit]
	d.mu.Unlock()
	if p != nil {
		return p.cmd.Process.Signal(syscall.SIGTERM)
	}
	return nil
}

func (d *directSupervisor) runAs(ctx context.Context, e execSpec) (Output, error) {
	if !engineBinary(e.Path) {
		return Output{}, fmt.Errorf("not allowlisted")
	}
	timeout := e.Timeout
	if timeout <= 0 {
		timeout = time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, e.Path, e.Args...)
	cmd.Env = append([]string{"PATH=/usr/bin:/bin", "LC_ALL=C"}, envFromFile(e.EnvironmentFile)...)
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(e.UID), Gid: uint32(e.GID)}}
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, io.Discard
	err := cmd.Run()
	if exit, ok := err.(*exec.ExitError); ok {
		return Output{Stdout: out.Bytes(), ExitCode: exit.ExitCode()}, nil
	}
	return Output{Stdout: out.Bytes()}, err
}

type lab struct {
	t        *testing.T
	dir      string
	h        *Helper
	clk      *clock.Fixed
	seq      int
	uid, gid int
	pgBin    string
	data     string
	sock     string
	conf     string
	pass     string
	log      strings.Builder
}

func (l *lab) as(name string, args ...string) string {
	l.t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = "/"
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LC_ALL=C", "HOME=" + l.dir}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(l.uid), Gid: uint32(l.gid)}}
	out, err := cmd.CombinedOutput()
	if err != nil {
		l.t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
	return string(out)
}

func (l *lab) mkdir(path string, mode os.FileMode, uid, gid int) {
	l.t.Helper()
	if err := os.MkdirAll(path, mode); err != nil {
		l.t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		l.t.Fatal(err)
	}
	if err := os.Chown(path, uid, gid); err != nil {
		l.t.Fatal(err)
	}
}

func (l *lab) sql(db, q string) string {
	l.t.Helper()
	return l.sqlAt(l.sock, labPort, db, q)
}

func (l *lab) sqlAt(sock string, port int, db, q string) string {
	l.t.Helper()
	c, err := pgwire.Connect(context.Background(), pgwire.Options{SocketDirectory: sock, Port: port, User: "postgres", Database: db})
	if err != nil {
		l.t.Fatal(err)
	}
	defer c.Close()
	rows, err := c.SimpleQuery(context.Background(), q)
	if err != nil {
		l.t.Fatalf("%s: %v", q, err)
	}
	if len(rows.Values) > 0 && len(rows.Values[0]) > 0 && rows.Values[0][0] != nil {
		return *rows.Values[0][0]
	}
	return ""
}

var labCrockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func (l *lab) job(name string, args canon.Object) []byte {
	l.t.Helper()
	l.seq++
	n := l.seq
	id := []byte("01M7000000000000000000000")
	for i := len(id) - 1; n > 0 && i > 4; i-- {
		id[i] = labCrockford[n%32]
		n /= 32
	}
	l.clk.T = time.Now().UTC().Truncate(time.Second)
	b, _ := canon.Canonicalize(args)
	sum := sha256.Sum256(b)
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	major := 1
	envelope := canon.Object{
		{Name: "jobId", Value: canon.String("job_" + string(id) + "0")},
		{Name: "operationId", Value: canon.String(operationID)},
		{Name: "nodeId", Value: canon.String(node)},
		{Name: "capability", Value: canon.Object{{Name: "name", Value: canon.String(name)}, {Name: "major", Value: canon.Number(major)}}},
		{Name: "args", Value: args},
		{Name: "argsHash", Value: canon.String("sha256:" + hex.EncodeToString(sum[:]))},
		{Name: "notBefore", Value: canon.String(l.clk.T.Format(time.RFC3339))},
		{Name: "expiresAt", Value: canon.String(l.clk.T.Add(15 * time.Minute).Format(time.RFC3339))},
		{Name: "nonce", Value: canon.String(nodecrypto.B64U(nonce))},
		{Name: "issuedAt", Value: canon.String(l.clk.T.Format(time.RFC3339))},
		{Name: "attempt", Value: canon.Number(1)},
	}
	signed, err := nodecrypto.SignJobEnvelope(envelope, keyID, seed)
	if err != nil {
		l.t.Fatal(err)
	}
	out, _ := canon.Canonicalize(signed)
	return out
}

func (l *lab) call(op, capability string, args canon.Object) (canon.Object, *ErrorBody) {
	l.t.Helper()
	req, _ := json.Marshal(Request{V: Version, Op: op, Job: l.job(capability, args)})
	resp := l.h.Handle(context.Background(), req)
	if resp.Error != nil {
		return nil, resp.Error
	}
	v, _ := canon.Parse(resp.Result)
	r := v.(canon.Object)
	if err := l.h.Schema.ValidateResult(capability+"@1", r); err != nil {
		l.t.Fatalf("%s result outside the contract: %v", capability, err)
	}
	out, _ := canon.Canonicalize(r)
	if strings.Contains(string(out), l.pass) || strings.Contains(string(out), "lab-restic-password") {
		l.t.Fatalf("%s result carries a secret", capability)
	}
	return r, nil
}

func (l *lab) must(op, capability string, args canon.Object) canon.Object {
	l.t.Helper()
	r, refusal := l.call(op, capability, args)
	if refusal != nil {
		l.t.Fatalf("%s refused: %s %s", capability, refusal.Code, refusal.Message)
	}
	return r
}

func (l *lab) cluster() canon.Object {
	return canon.Object{{Name: "localName", Value: canon.String("17/lab")}, {Name: "systemIdentifier", Value: canon.String(l.sysid())}}
}

func (l *lab) sysid() string {
	return l.sql("postgres", "SELECT system_identifier::text FROM pg_control_system()")
}

func (l *lab) repo() canon.Object {
	return canon.Object{{Name: "repositoryId", Value: canon.String(labRepo)}, {Name: "engine", Value: canon.String("pgbackrest")},
		{Name: "stanza", Value: canon.String("lab")}, {Name: "repoIndex", Value: canon.Number(1)}}
}

func (l *lab) resticRepo() canon.Object {
	return canon.Object{{Name: "repositoryId", Value: canon.String(labRestic)}, {Name: "engine", Value: canon.String("restic")},
		{Name: "stanza", Value: canon.Null{}}, {Name: "repoIndex", Value: canon.Null{}}}
}

func (l *lab) mode(repo, m string) {
	dir := l.dir + "/repos/" + repo
	l.mkdir(dir, 0o755, 0, 0)
	if err := os.WriteFile(dir+"/mode", []byte(m+"\n"), 0o644); err != nil {
		l.t.Fatal(err)
	}
	if repo == labRepo {
		// The host binds the repository id to its stanza and repo (B-1).
		if err := os.WriteFile(dir+"/pgbackrest", []byte("stanza=lab\nrepo=1\n"), 0o644); err != nil {
			l.t.Fatal(err)
		}
	}
}

// wait polls run.status until the run ends and returns the final status.
func (l *lab) wait(runID string, startResult canon.Object, timeout time.Duration) canon.Object {
	l.t.Helper()
	runDir := l.dir + "/engine/runs/" + runID
	data, err := os.ReadFile(runDir + "/record.json")
	if err != nil {
		l.t.Fatal(err)
	}
	var rec runRecord
	if err := decodeStrict(data, &rec); err != nil {
		l.t.Fatal(err)
	}
	deadline := time.Now().Add(timeout)
	for {
		st := l.must(OpRunStatus, "run.status", statusArgs(rec))
		switch s := str(st, "state"); s {
		case "succeeded", "failed", "canceled", "lost":
			out, _ := canon.Canonicalize(st)
			if s != "succeeded" {
				child, _ := os.ReadFile(l.dir + "/" + runID + ".log")
				l.t.Logf("child output: %s", child)
			}
			fmt.Fprintf(&l.log, "%s %s: %s\n", rec.Capability, runID, out)
			l.t.Logf("%s %s: %s", rec.Capability, runID, out)
			// No file of the run holds a secret.
			filepath.Walk(runDir, func(p string, info os.FileInfo, err error) error {
				if err == nil && info.Mode().IsRegular() {
					b, _ := os.ReadFile(p)
					if bytes.Contains(b, []byte(l.pass)) || bytes.Contains(b, []byte("lab-restic-password")) {
						l.t.Errorf("%s holds a secret", p)
					}
				}
				return nil
			})
			return st
		}
		if time.Now().After(deadline) {
			child, _ := os.ReadFile(l.dir + "/" + runID + ".log")
			l.t.Fatalf("run %s did not end: %s", runID, child)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func outcomeOf(st canon.Object) canon.Object {
	v, _ := st.Get("outcome")
	o, _ := v.(canon.Object)
	return o
}

func (l *lab) labelOf(st canon.Object) string {
	v, _ := outcomeOf(st).Get("label")
	s, _ := v.(canon.String)
	return string(s)
}

func TestPglab(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Fatal("the lab runs as root (it creates a disposable cluster as the postgres user)")
	}
	pg, err := user.Lookup("postgres")
	if err != nil {
		t.Fatal(err)
	}
	uid, _ := strconv.Atoi(pg.Uid)
	gid, _ := strconv.Atoi(pg.Gid)
	dir, err := os.MkdirTemp("/tmp", "exl")
	if err != nil {
		t.Fatal(err)
	}
	l := &lab{t: t, dir: dir, uid: uid, gid: gid, pgBin: "/usr/lib/postgresql/17/bin", data: dir + "/pg/data", sock: dir + "/pg/sock",
		conf: dir + "/etc/pgbackrest.conf"}
	t.Cleanup(func() {
		_ = exec.Command(l.pgBin+"/pg_ctl", "-D", l.data, "-m", "immediate", "stop").Run()
		_ = exec.Command(l.pgBin+"/pg_ctl", "-D", dir+"/pub/data", "-m", "immediate", "stop").Run()
		_ = os.RemoveAll(dir)
	})
	l.mkdir(dir, 0o711, 0, 0)
	for _, d := range []string{"/pg", "/repo", "/log", "/lock", "/spool", "/restic"} {
		l.mkdir(dir+d, 0o750, uid, gid)
	}
	l.mkdir(l.sock, 0o750, uid, gid)
	l.mkdir(dir+"/etc", 0o755, 0, 0)
	l.mkdir(dir+"/engine", 0o711, 0, 0)
	l.mkdir(dir+"/repos", 0o755, 0, 0)
	l.mkdir(dir+"/state", 0o700, 0, 0)
	l.mkdir(dir+"/bin", 0o755, 0, 0)
	// The test binary, re-executed as postgres for the engine runs.
	self, _ := os.Executable()
	bin, _ := os.ReadFile(self)
	if err := os.WriteFile(dir+"/bin/helper.test", bin, 0o755); err != nil {
		t.Fatal(err)
	}
	// A disposable encrypted pgBackRest repository.
	raw := make([]byte, 33)
	_, _ = rand.Read(raw)
	l.pass = nodecrypto.B64U(raw)
	conf := "[global]\nrepo1-path=" + dir + "/repo\nrepo1-cipher-type=aes-256-cbc\nrepo1-cipher-pass=" + l.pass +
		"\nlog-path=" + dir + "/log\nlock-path=" + dir + "/lock\nspool-path=" + dir + "/spool\nstart-fast=y\narchive-async=n\n\n[lab]\npg1-path=" +
		l.data + "\npg1-socket-path=" + l.sock + "\npg1-port=" + strconv.Itoa(labPort) + "\n"
	if err := os.WriteFile(l.conf, []byte(conf), 0o640); err != nil {
		t.Fatal(err)
	}
	_ = os.Chown(l.conf, 0, gid)

	// A disposable PostgreSQL 17 cluster that archives into the repository.
	l.as(l.pgBin+"/initdb", "-D", l.data, "-A", "trust", "--data-checksums", "-U", "postgres")
	f, _ := os.OpenFile(l.data+"/postgresql.conf", os.O_APPEND|os.O_WRONLY, 0)
	fmt.Fprintf(f, "port = %d\nlisten_addresses = ''\nunix_socket_directories = '%s'\narchive_mode = on\n"+
		"archive_command = 'pgbackrest --config=%s --stanza=lab archive-push %%p'\nwal_level = replica\n", labPort, l.sock, l.conf)
	f.Close()
	logFile := dir + "/pg/server.log"
	l.as(l.pgBin+"/pg_ctl", "-D", l.data, "-l", logFile, "-w", "start")
	l.as("/usr/bin/pgbackrest", "--config="+l.conf, "--stanza=lab", "stanza-create")
	l.sql("postgres", "CREATE DATABASE app")
	l.sql("postgres", "CREATE EXTENSION amcheck")
	l.sql("app", "CREATE EXTENSION amcheck")
	l.sql("app", "CREATE TABLE public.accounts (id int PRIMARY KEY, name text); CREATE INDEX ON public.accounts (name)")
	l.sql("app", "INSERT INTO public.accounts SELECT g, 'a' || g FROM generate_series(1, 100) g")

	// A publisher on this host and an enabled subscription to it in the
	// source (C-2): a restored copy must never connect to the publisher.
	pubSock := dir + "/pub/sock"
	l.mkdir(dir+"/pub", 0o750, uid, gid)
	l.mkdir(pubSock, 0o750, uid, gid)
	l.as(l.pgBin+"/initdb", "-D", dir+"/pub/data", "-A", "trust", "-U", "postgres")
	pf, _ := os.OpenFile(dir+"/pub/data/postgresql.conf", os.O_APPEND|os.O_WRONLY, 0)
	fmt.Fprintf(pf, "port = %d\nlisten_addresses = ''\nunix_socket_directories = '%s'\nwal_level = logical\n", pubPort, pubSock)
	pf.Close()
	l.as(l.pgBin+"/pg_ctl", "-D", dir+"/pub/data", "-l", dir+"/pub/server.log", "-w", "start")
	l.sqlAt(pubSock, pubPort, "postgres", "CREATE TABLE public.items (id int PRIMARY KEY); CREATE PUBLICATION p FOR TABLE public.items")
	l.sqlAt(pubSock, pubPort, "postgres", "INSERT INTO public.items SELECT generate_series(1, 10)")
	l.sql("app", "CREATE TABLE public.items (id int PRIMARY KEY)")
	l.sql("app", fmt.Sprintf("CREATE SUBSCRIPTION s CONNECTION 'host=%s port=%d dbname=postgres user=postgres' PUBLICATION p", pubSock, pubPort))
	for i := 0; l.sql("app", "SELECT count(*) FROM public.items") != "10"; i++ {
		if i > 100 {
			t.Fatal("the subscription did not sync")
		}
		time.Sleep(200 * time.Millisecond)
	}

	// The helper over the lab: real files and engines, the direct supervisor.
	l.clk = &clock.Fixed{T: time.Now().UTC(), Synced: true}
	ledger, err := journal.OpenLedger(dir+"/state", "effects.log", l.clk.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer ledger.Close()
	pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	trustPath := dir + "/state/helper-trust.json"
	if err := SaveTrust(trustPath, &Trust{Schema: TrustSchema, InstallationID: installation, NodeID: node,
		JobKeys: []state.JobKey{{KeyID: keyID, PublicKey: nodecrypto.B64U(pub)}}}); err != nil {
		t.Fatal(err)
	}
	sv, err := schema.Protocol()
	if err != nil {
		t.Fatal(err)
	}
	l.h = &Helper{
		Config: &config.Config{Schema: config.Schema, StateDirectory: "/var/lib/exponetdb-node", HelperSocket: "/run/x.sock",
			PgBackRestConfig: l.conf, Instances: []config.Instance{{
				LocalName: "17/lab", Unit: "postgresql@17-lab.service", Port: labPort, SocketDirectory: l.sock, DataDirectory: l.data,
				ConfigFile: l.data + "/postgresql.conf", HbaFile: l.data + "/pg_hba.conf", ManagedInclude: l.data + "/conf.d/90.conf"}}},
		Schema: sv, Clock: l.clk, Ledger: ledger, Runner: ExecRunner{}, TrustPath: trustPath, TrustOwner: 0,
		StagingDirectory: dir + "/state", StateDirectory: dir + "/state",
		Paths:      Paths{Engine: dir + "/engine", Repositories: dir + "/repos"},
		supervisor: &directSupervisor{binary: dir + "/bin/helper.test", logDir: dir, procs: map[string]*labProc{}},
	}

	// 1. A full backup through backup.run@1 (repository mode owned).
	l.mode(labRepo, ModeOwned)
	runFull := "run_01M70000000000000000000F01"
	r := l.must(OpBackupRun, "backup.run", runArgsOf(l.cluster(), l.repo(), runFull, "full"))
	st := l.wait(runFull, r, 5*time.Minute)
	full := l.labelOf(st)
	if str(st, "state") != "succeeded" || !strings.HasSuffix(full, "F") {
		t.Fatalf("full backup: %v", st)
	}
	// A second start of the same run id is refused.
	if _, refusal := l.call(OpBackupRun, "backup.run", runArgsOf(l.cluster(), l.repo(), runFull, "full")); refusal == nil || refusal.Code != CodePreconditionFailed {
		t.Fatalf("second start: %+v", refusal)
	}

	// 2. More data and WAL, then an incremental on an adopted_runs repository.
	l.sql("app", "INSERT INTO public.accounts SELECT g, 'b' || g FROM generate_series(101, 150) g")
	l.sql("postgres", "SELECT pg_switch_wal()")
	l.mode(labRepo, ModeAdoptedRuns)
	if _, refusal := l.call(OpBackupRun, "backup.run", runArgsOf(l.cluster(), l.repo(), "run_01M70000000000000000000F02", "full")); refusal == nil {
		t.Fatal("a full backup ran on adopted_runs")
	}
	runIncr := "run_01M70000000000000000000B01"
	st = l.wait(runIncr, l.must(OpBackupRun, "backup.run", runArgsOf(l.cluster(), l.repo(), runIncr, "incremental")), 5*time.Minute)
	incr := l.labelOf(st)
	if str(st, "state") != "succeeded" || !strings.HasPrefix(incr, full+"_") || !strings.HasSuffix(incr, "I") {
		t.Fatalf("incremental: %v", st)
	}

	// 3. backup.list@1 parses the engine's catalog.
	list := l.must(OpBackupList, "backup.list", canon.Object{{Name: "cluster", Value: l.cluster()}, {Name: "repository", Value: l.repo()}})
	out, _ := canon.Canonicalize(list)
	t.Logf("backup.list: %s", out)
	fmt.Fprintf(&l.log, "backup.list: %s\n", out)
	for _, want := range []string{`"label":"` + full + `"`, `"label":"` + incr + `"`, `"kind":"incremental"`, `"systemIdentifier":"` + l.sysid() + `"`,
		`"cipher":"aes-256-cbc"`, `"engineVersion":"2.60.0"`, `"postgresMajor":17`, `"status":"ok"`} {
		if !strings.Contains(string(out), want) {
			t.Fatalf("backup.list lacks %s", want)
		}
	}

	// 4. backup.verify@1 of the repository.
	runVerify := "run_01M70000000000000000000V01"
	st = l.wait(runVerify, l.must(OpBackupVerify, "backup.verify", canon.Object{{Name: "cluster", Value: l.cluster()}, {Name: "repository", Value: l.repo()},
		{Name: "runId", Value: canon.String(runVerify)}, {Name: "label", Value: canon.Null{}}, {Name: "snapshot", Value: canon.Null{}}}), 5*time.Minute)
	if str(st, "state") != "succeeded" {
		t.Fatalf("verify: %v", st)
	}

	// 5. A point in time: rows 1..160 exist (151..160 committed after the
	// incremental, replayed from the archive); rows after it do not.
	l.sql("app", "INSERT INTO public.accounts SELECT g, 'c' || g FROM generate_series(151, 160) g")
	time.Sleep(1100 * time.Millisecond)
	target := time.Now().UTC().Truncate(time.Second)
	time.Sleep(1100 * time.Millisecond)
	l.sql("app", "INSERT INTO public.accounts SELECT g, 'd' || g FROM generate_series(161, 200) g")
	// The real subscriber stops after the target: the restored copy holds the
	// subscription enabled. Changes then wait on the publisher's slot.
	l.sql("app", "ALTER SUBSCRIPTION s DISABLE")
	for i := 0; l.sqlAt(pubSock, pubPort, "postgres", "SELECT count(*) FROM pg_replication_slots WHERE slot_name = 's' AND NOT active") != "1"; i++ {
		if i > 100 {
			t.Fatal("the subscription's slot stays active")
		}
		time.Sleep(200 * time.Millisecond)
	}
	l.sqlAt(pubSock, pubPort, "postgres", "INSERT INTO public.items SELECT generate_series(11, 1000)")
	slotBefore := l.sqlAt(pubSock, pubPort, "postgres", "SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name = 's'")
	l.sql("postgres", "SELECT pg_switch_wal()")
	l.sql("postgres", "SELECT pg_switch_wal()")
	// The archive holds the WAL past the target.
	l.as("/usr/bin/pgbackrest", "--config="+l.conf, "--stanza=lab", "check")
	runRestore := "run_01M70000000000000000000R01"
	targetObj := canon.Object{{Name: "label", Value: canon.Null{}}, {Name: "time", Value: canon.String(target.Format(time.RFC3339))},
		{Name: "lsn", Value: canon.Null{}}, {Name: "timeline", Value: canon.Null{}}}
	prep := l.must(OpRestorePrepare, "restore.prepare", canon.Object{{Name: "cluster", Value: l.cluster()}, {Name: "repository", Value: l.repo()},
		{Name: "runId", Value: canon.String(runRestore)}, {Name: "purpose", Value: canon.String("drill")}, {Name: "target", Value: targetObj}})
	out, _ = canon.Canonicalize(prep)
	t.Logf("restore.prepare: %s", out)
	fmt.Fprintf(&l.log, "restore.prepare: %s\n", out)
	port, _ := prep.Get("port")
	if ecr, _ := prep.Get("engineCanRead"); ecr != canon.Bool(true) || len(list2(prep, "refusals")) != 0 {
		t.Fatalf("prepare: %s", out)
	}
	execArgs := canon.Object{{Name: "cluster", Value: l.cluster()}, {Name: "repository", Value: l.repo()}, {Name: "runId", Value: canon.String(runRestore)},
		{Name: "purpose", Value: canon.String("drill")}, {Name: "target", Value: targetObj}, {Name: "port", Value: port},
		{Name: "checks", Value: canon.Array{canon.String("recovery_target_reached"), canon.String("probe_simple"), canon.String("probe_extended"),
			canon.String("amcheck"), canon.String("row_counts")}},
		{Name: "rowCounts", Value: canon.Array{canon.Object{{Name: "database", Value: canon.String("app")}, {Name: "schema", Value: canon.String("public")},
			{Name: "table", Value: canon.String("accounts")}, {Name: "min", Value: canon.Number(160)}, {Name: "max", Value: canon.Number(160)}}}}}
	st = l.wait(runRestore, l.must(OpRestoreExecute, "restore.execute", execArgs), 10*time.Minute)
	if str(st, "state") != "succeeded" {
		t.Fatalf("restore: %v", st)
	}
	checks, _ := outcomeOf(st).Get("checks")
	for _, c := range checks.(canon.Array) {
		if o, _ := c.(canon.Object).Get("outcome"); o != canon.String("passed") {
			t.Fatalf("check not passed: %v", c)
		}
	}
	if len(checks.(canon.Array)) != 5 {
		t.Fatalf("checks: %v", checks)
	}
	reached, _ := outcomeOf(st).Get("recoveryReachedAt")
	at, err := time.Parse(time.RFC3339Nano, string(reached.(canon.String)))
	if err != nil || at.After(target) || target.Sub(at) > 10*time.Second {
		t.Fatalf("the replay ended at %v for the target %v", reached, target)
	}
	// The scratch cluster is stopped, outside every data directory, and
	// never archived into the repository (archive_mode off).
	scratch := dir + "/engine/scratch/" + runRestore
	if _, err := os.Stat(scratch + "/postmaster.pid"); !os.IsNotExist(err) {
		t.Fatal("the scratch cluster still runs")
	}

	// 6. restore.verify@1 again on the stopped scratch cluster.
	runReverify := "run_01M70000000000000000000R02"
	st = l.wait(runReverify, l.must(OpRestoreVerify, "restore.verify", canon.Object{{Name: "runId", Value: canon.String(runRestore)},
		{Name: "verifyRunId", Value: canon.String(runReverify)}, {Name: "port", Value: port},
		{Name: "checks", Value: canon.Array{canon.String("probe_simple"), canon.String("amcheck"), canon.String("row_counts")}}}), 5*time.Minute)
	if str(st, "state") != "succeeded" {
		t.Fatalf("reverify: %v", st)
	}

	// C-2: the drill and its reverification never reached the publisher.
	time.Sleep(2 * time.Second)
	if after := l.sqlAt(pubSock, pubPort, "postgres", "SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name = 's'"); after != slotBefore {
		t.Fatalf("the publisher's slot moved from %s to %s", slotBefore, after)
	}
	if n := l.sqlAt(pubSock, pubPort, "postgres", "SELECT count(*) FROM pg_stat_replication"); n != "0" {
		t.Fatalf("%s replication connections on the publisher", n)
	}
	if n := l.sql("app", "SELECT count(*) FROM public.items"); n != "10" {
		t.Fatalf("the subscriber holds %s rows", n)
	}
	t.Logf("publisher slot confirmed_flush_lsn before and after the drill: %s", slotBefore)
	fmt.Fprintf(&l.log, "C-2: publisher slot confirmed_flush_lsn %s unchanged, 0 replication connections\n", slotBefore)

	// 7. Expiry: owned only; a retention that would drop a kept label is
	// refused before the engine runs; a safe one runs.
	l.mode(labRepo, ModeOwned)
	runFull2 := "run_01M70000000000000000000F03"
	st = l.wait(runFull2, l.must(OpBackupRun, "backup.run", runArgsOf(l.cluster(), l.repo(), runFull2, "full")), 5*time.Minute)
	full2 := l.labelOf(st)
	expire := func(run string, keep string) canon.Object {
		return canon.Object{{Name: "cluster", Value: l.cluster()}, {Name: "repository", Value: l.repo()}, {Name: "runId", Value: canon.String(run)},
			{Name: "retention", Value: canon.Object{{Name: "fullCount", Value: canon.Number(1)}, {Name: "differentialCount", Value: canon.Null{}}, {Name: "logicalDays", Value: canon.Null{}}}},
			{Name: "keepLabels", Value: canon.Array{canon.String(keep)}}}
	}
	runExp1 := "run_01M70000000000000000000E01"
	st = l.wait(runExp1, l.must(OpBackupExpire, "backup.expire", expire(runExp1, full)), 5*time.Minute)
	if str(st, "state") != "failed" || !strings.Contains(str(st, "excerpt"), "refused") {
		t.Fatalf("unsafe expiry: %v", st)
	}
	// The engine's dry-run lines, as engine-run parses them (B-3).
	dry := l.as("/usr/bin/pgbackrest", "--config="+l.conf, "--stanza=lab", "--repo=1", "--repo1-retention-full-type=count",
		"--repo1-retention-full=1", "--dry-run", "--log-level-console=info", "expire")
	var planned []string
	for _, line := range strings.Split(dry, "\n") {
		if expireLineRE.MatchString(line) {
			planned = append(planned, labelTokenRE.FindAllString(line, -1)...)
		}
	}
	t.Logf("dry run plans to expire %v", planned)
	fmt.Fprintf(&l.log, "B-3 dry run plans %v\n", planned)
	if !contains(planned, full) || contains(planned, full2) {
		t.Fatalf("dry run %v:\n%s", planned, dry)
	}
	runExp2 := "run_01M70000000000000000000E02"
	st = l.wait(runExp2, l.must(OpBackupExpire, "backup.expire", expire(runExp2, full2)), 5*time.Minute)
	if str(st, "state") != "succeeded" {
		t.Fatalf("expiry: %v", st)
	}
	list = l.must(OpBackupList, "backup.list", canon.Object{{Name: "cluster", Value: l.cluster()}, {Name: "repository", Value: l.repo()}})
	out, _ = canon.Canonicalize(list)
	if strings.Contains(string(out), `"label":"`+full+`"`) || !strings.Contains(string(out), `"label":"`+full2+`"`) {
		t.Fatalf("after the expiry: %s", out)
	}

	// 8. Cancel of a finished run; discard of the scratch restore.
	if c := l.must(OpRunCancel, "run.cancel", canon.Object{{Name: "runId", Value: canon.String(runRestore)}}); str(c, "state") != "already_finished" {
		t.Fatalf("cancel: %v", c)
	}
	d := l.must(OpRestoreDiscard, "restore.discard", canon.Object{{Name: "runId", Value: canon.String(runRestore)}})
	if !boolOf(d, "removed") {
		t.Fatalf("discard: %v", d)
	}
	if _, err := os.Lstat(scratch); !os.IsNotExist(err) {
		t.Fatal("the scratch directory is still there")
	}
	if c := l.sql("app", "SELECT count(*) FROM public.accounts"); c != "200" {
		t.Fatalf("the source cluster changed: %s rows", c)
	}

	// 9. A logical backup to restic: pg_dump, then restic with the password
	// in a file of the run only.
	l.mode(labRestic, ModeOwned)
	rdir := dir + "/repos/" + labRestic
	_ = os.WriteFile(rdir+"/repository", []byte(dir+"/restic/repo\n"), 0o600)
	_ = os.WriteFile(rdir+"/password", []byte("lab-restic-password"), 0o600)
	pw := dir + "/restic/pw"
	_ = os.WriteFile(pw, []byte("lab-restic-password"), 0o600)
	_ = os.Chown(pw, uid, gid)
	l.as("/usr/bin/restic", "init", "--no-cache", "--repo", dir+"/restic/repo", "--password-file", pw)
	_ = os.Remove(pw)
	runLogical := "run_01M70000000000000000000G01"
	st = l.wait(runLogical, l.must(OpBackupRun, "backup.run", runArgsOf(l.cluster(), l.resticRepo(), runLogical, "logical", "app")), 5*time.Minute)
	if str(st, "state") != "succeeded" || len(l.labelOf(st)) != 64 {
		t.Fatalf("logical: %v", st)
	}
	list = l.must(OpBackupList, "backup.list", canon.Object{{Name: "cluster", Value: l.cluster()}, {Name: "repository", Value: l.resticRepo()}})
	out, _ = canon.Canonicalize(list)
	t.Logf("backup.list restic: %s", out)
	fmt.Fprintf(&l.log, "backup.list restic: %s\n", out)
	if !strings.Contains(string(out), l.labelOf(st)) {
		t.Fatalf("restic list: %s", out)
	}
	runCheck := "run_01M70000000000000000000G02"
	st = l.wait(runCheck, l.must(OpBackupVerify, "backup.verify", canon.Object{{Name: "cluster", Value: l.cluster()}, {Name: "repository", Value: l.resticRepo()},
		{Name: "runId", Value: canon.String(runCheck)}, {Name: "label", Value: canon.Null{}}, {Name: "snapshot", Value: canon.Null{}}}), 5*time.Minute)
	if str(st, "state") != "succeeded" {
		t.Fatalf("restic check: %v", st)
	}
	// 10. A cancel while a backup runs: the engine began its effect, so the
	// run ends failed, never canceled (ADR-0037 §4).
	l.sql("app", "CREATE TABLE public.filler AS SELECT g, repeat(md5(g::text), 20) AS pad FROM generate_series(1, 400000) g")
	runCancel := "run_01M70000000000000000000C01"
	l.must(OpBackupRun, "backup.run", runArgsOf(l.cluster(), l.repo(), runCancel, "full"))
	time.Sleep(1500 * time.Millisecond)
	c := l.must(OpRunCancel, "run.cancel", canon.Object{{Name: "runId", Value: canon.String(runCancel)}})
	st = l.wait(runCancel, nil, 5*time.Minute)
	switch str(c, "state") {
	case "stopping":
		if str(st, "state") != "failed" || !strings.Contains(str(st, "excerpt"), "after the engine began") {
			t.Fatalf("cancel after the effect: %v", st)
		}
	case "already_finished":
		t.Logf("the backup ended before the cancel: %v", st)
	default:
		t.Fatalf("cancel: %v", c)
	}
	fmt.Fprintf(&l.log, "run.cancel: %s\n", str(c, "state"))
	if path := os.Getenv("EXDB_PGLAB_LOG"); path != "" {
		_ = os.WriteFile(path, []byte(l.log.String()), 0o644)
	}
}

func list2(o canon.Object, name string) canon.Array {
	v, _ := o.Get(name)
	a, _ := v.(canon.Array)
	return a
}

func runArgsOf(cluster, repo canon.Object, run, kind string, dbs ...string) canon.Object {
	a := runArgs(run, kind, repo, dbs...)
	a[0].Value = cluster
	return a
}

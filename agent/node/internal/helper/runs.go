package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/user"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/fsafe"
)

// Engine runs (ADR-0037): a long-running backup, verification, expiry or
// restore is a transient systemd unit that runs this binary's engine-run
// program as the PostgreSQL server's user. The helper validates the job,
// writes the run record and starts the unit in seconds; run.status@1 reads
// the record, the unit and the engine's outcome; run.cancel@1 stops the
// unit. Nothing of a run (path, option, command) comes from the Control
// Plane beyond the contract-validated arguments the record keeps.

// Paths are the host locations of the runs; tests and the lab set them,
// production uses DefaultPaths.
type Paths struct {
	// Engine holds runs/ and scratch/ (root-owned, 0711: traversable by the
	// engine user, listable by root only). The packaging creates it
	// (tmpfiles.d); the helper creates runs/ and scratch/ inside.
	Engine string
	// Repositories holds the operator-provisioned repository directories.
	Repositories string
	// PostgresLib holds the PostgreSQL binaries per major (Debian/PGDG).
	PostgresLib string
	// HelperBinary is this binary, run by the transient unit as
	// `engine-run --run <runId>`.
	HelperBinary string
}

// DefaultPaths are the production locations. The engine directory is not
// the agent's state directory (/var/lib/exponetdb-node, owned by the agent
// user, 0700): root's run records must not live under a directory a less
// trusted user owns, and the engine user must be able to reach its run and
// scratch directories.
var DefaultPaths = Paths{
	Engine:       "/var/lib/exponetdb-node-engine",
	Repositories: "/etc/exponetdb-node/repositories",
	PostgresLib:  "/usr/lib/postgresql",
	HelperBinary: "/usr/sbin/exponetdb-node-helper",
}

func (h *Helper) paths() Paths {
	p := DefaultPaths
	if h.Paths.Engine != "" {
		p.Engine = h.Paths.Engine
	}
	if h.Paths.Repositories != "" {
		p.Repositories = h.Paths.Repositories
	}
	if h.Paths.PostgresLib != "" {
		p.PostgresLib = h.Paths.PostgresLib
	}
	if h.Paths.HelperBinary != "" {
		p.HelperBinary = h.Paths.HelperBinary
	}
	return p
}

// The binaries the runs use: fixed paths; PostgreSQL's are resolved per major.
const (
	SystemdRun = "/usr/bin/systemd-run"
	PgBackRest = "/usr/bin/pgbackrest"
	Restic     = "/usr/bin/restic"
)

// The run limits per purpose (ADR-0037 §2): systemd stops a unit at its
// RuntimeMaxSec.
var runtimeMax = map[string]time.Duration{
	"backup": 12 * time.Hour, "verify": 12 * time.Hour, "expire": time.Hour,
	"restore": 24 * time.Hour, "reverify": time.Hour,
}

var memoryMax = map[string]string{
	"backup": "2G", "verify": "2G", "expire": "1G", "restore": "4G", "reverify": "4G",
}

// startBudget bounds a start operation (validation, record, systemd-run):
// the queue wait, it and the kill delay fit the start capabilities'
// settleSeconds (95 s). discardBudget bounds restore.discard (settle 635 s).
const (
	startBudget   = 60 * time.Second
	discardBudget = 9 * time.Minute
	// startGrace: a record without a unit, an outcome or a result is
	// "starting" this long after it was written, "lost" afterwards.
	startGrace = 2 * time.Minute
	// engineGrace: the stop timeout of a unit (the engine's own cleanup).
	engineGrace = 90 * time.Second
)

var runIDRE = regexp.MustCompile(`^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$`)

// ValidRunID reports whether s is a run id.
func ValidRunID(s string) bool { return runIDRE.MatchString(s) }

// UnitName is the transient unit of a run.
func UnitName(runID string) string { return "exponetdb-run-" + runID + ".service" }

// RecordSchema names the run record format.
const RecordSchema = "exponetdb.engine-run/v1"

type engineUser struct {
	Name string `json:"name"`
	UID  int    `json:"uid"`
	GID  int    `json:"gid"`
}

type recordInstance struct {
	SocketDirectory string `json:"socketDirectory"`
	Port            int    `json:"port"`
}

type recordPgbr struct {
	Config string `json:"config"`
	// Include is the conf.d directory the helper read ("" when none).
	Include string `json:"include"`
	Stanza  string `json:"stanza"`
	Repo    int    `json:"repo"`
}

type rowCount struct {
	Database string `json:"database"`
	Schema   string `json:"schema"`
	Table    string `json:"table"`
	Min      int64  `json:"min"`
	Max      int64  `json:"max"`
}

// runRecord is written by the helper (root) before the unit starts and read
// by engine-run (the engine user) and by run.status@1.
type runRecord struct {
	Schema           string          `json:"schema"`
	RunID            string          `json:"runId"`
	StartJobID       string          `json:"startJobId"`
	StartArgsHash    string          `json:"startArgsHash"`
	OperationID      string          `json:"operationId"`
	Capability       string          `json:"capability"`
	Purpose          string          `json:"purpose"`
	Domain           string          `json:"domain"`
	SystemIdentifier string          `json:"systemIdentifier"`
	RepositoryID     string          `json:"repositoryId"`
	Engine           string          `json:"engine"`
	StartedAt        string          `json:"startedAt"`
	Unit             string          `json:"unit"`
	EngineUser       engineUser      `json:"engineUser"`
	PostgresMajor    int             `json:"postgresMajor"`
	PostgresBin      string          `json:"postgresBin"`
	Instance         *recordInstance `json:"instance"`
	PgBackRest       *recordPgbr     `json:"pgbackrest"`
	WorkDirectory    string          `json:"workDirectory"`
	ScratchDirectory string          `json:"scratchDirectory"`
	ScratchRunID     string          `json:"scratchRunId"`
	RowCounts        []rowCount      `json:"rowCounts"`
	Args             json.RawMessage `json:"args"`
}

// decodeStrict reads strict JSON into v (duplicate and unknown members refused).
func decodeStrict(data []byte, v any) error {
	if _, err := canon.Parse(data); err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("helper: trailing data")
	}
	return nil
}

func (r *runRecord) validate() error {
	switch {
	case r.Schema != RecordSchema, !runIDRE.MatchString(r.RunID), r.Unit != UnitName(r.RunID),
		!regexp.MustCompile(`^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$`).MatchString(r.StartJobID),
		!regexp.MustCompile(`^sha256:[0-9a-f]{64}$`).MatchString(r.StartArgsHash),
		runtimeMax[r.Purpose] == 0, r.Domain != "backup" && r.Domain != "restore",
		!regexp.MustCompile(`^[0-9]{1,20}$`).MatchString(r.SystemIdentifier),
		r.EngineUser.UID <= 0, r.EngineUser.GID < 0, !regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`).MatchString(r.EngineUser.Name),
		r.PostgresMajor < 16 || r.PostgresMajor > 18, len(r.Args) == 0:
		return errors.New("helper: the run record is invalid")
	}
	if _, err := time.Parse(time.RFC3339, r.StartedAt); err != nil {
		return errors.New("helper: the run record is invalid")
	}
	return nil
}

// runOutcome is what engine-run writes (as the engine user) when it ends;
// the helper reads it as untrusted data.
type runOutcome struct {
	Schema             string      `json:"schema"`
	State              string      `json:"state"`
	ExitCode           *int        `json:"exitCode"`
	FinishedAt         string      `json:"finishedAt"`
	Excerpt            string      `json:"excerpt"`
	Label              *string     `json:"label"`
	VerifyErrors       *int64      `json:"verifyErrors"`
	RecoveryReachedLsn *string     `json:"recoveryReachedLsn"`
	RecoveryReachedAt  *string     `json:"recoveryReachedAt"`
	Timeline           *int64      `json:"timeline"`
	Port               *int        `json:"port"`
	Checks             []checkItem `json:"checks"`
	Phases             []phaseItem `json:"phases"`
}

// OutcomeSchema names the engine outcome format.
const OutcomeSchema = "exponetdb.engine-outcome/v1"

type checkItem struct {
	Check   string  `json:"check"`
	Outcome string  `json:"outcome"`
	Detail  *string `json:"detail"`
}

type phaseItem struct {
	Name       string  `json:"name"`
	StartedAt  string  `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
	Outcome    string  `json:"outcome"`
}

type runProgress struct {
	Percent *float64 `json:"percent"`
	Bytes   *int64   `json:"bytes"`
}

// ----- the supervisor -----

// unitSpec is a run's transient unit: fixed properties, the engine user and
// the paths it may write.
type unitSpec struct {
	Unit     string
	RunID    string
	Purpose  string
	UID, GID int
	// ReadWrite are paths that exist; Optional are written only if they
	// exist ('-'); Bind are bind-mounted from the host into the unit's
	// private /tmp ('-').
	ReadWrite, Optional, Bind []string
	// EnvironmentFile is read by systemd itself (root-only file); its values
	// are never in an argument or a unit property.
	EnvironmentFile string
}

// execSpec is a short command run as the engine user (a catalog read).
type execSpec struct {
	UID, GID        int
	Path            string
	Args            []string
	Optional, Bind  []string
	EnvironmentFile string
	Timeout         time.Duration
}

type unitState struct {
	Loaded     bool
	Active     bool
	ActiveText string
	Result     string
	ExitStatus *int
}

// supervisor starts, observes and stops runs; systemd in production, a
// direct child in the lab test.
type supervisor interface {
	start(ctx context.Context, s unitSpec) error
	states(ctx context.Context, units []string) (map[string]unitState, error)
	stop(ctx context.Context, unit string) error
	runAs(ctx context.Context, s execSpec) (Output, error)
}

func (h *Helper) sup() supervisor {
	if h.supervisor != nil {
		return h.supervisor
	}
	return systemdSupervisor{runner: h.Runner, helperBinary: h.paths().HelperBinary}
}

// systemdSupervisor drives systemd with fixed argument templates.
type systemdSupervisor struct {
	runner       Runner
	helperBinary string
}

// hardening are the properties every run and every read unit gets.
func hardening(uid, gid int) []string {
	return []string{
		"--property=User=" + strconv.Itoa(uid),
		"--property=Group=" + strconv.Itoa(gid),
		"--property=NoNewPrivileges=yes",
		"--property=PrivateTmp=yes",
		"--property=PrivateDevices=yes",
		"--property=ProtectSystem=strict",
		"--property=ProtectHome=yes",
		"--property=ProtectKernelTunables=yes",
		"--property=ProtectKernelModules=yes",
		"--property=ProtectControlGroups=yes",
		"--property=RestrictSUIDSGID=yes",
		"--property=LimitCORE=0",
		"--property=UMask=0077",
		"--property=KillMode=control-group",
		"--property=CPUWeight=50",
		"--property=IOWeight=50",
		"--property=TasksMax=256",
	}
}

func pathProperties(rw, optional, bind []string, envFile string) []string {
	var out []string
	for _, p := range rw {
		out = append(out, "--property=ReadWritePaths="+p)
	}
	for _, p := range optional {
		out = append(out, "--property=ReadWritePaths=-"+p)
	}
	for _, p := range bind {
		out = append(out, "--property=BindPaths=-"+p)
	}
	if envFile != "" {
		out = append(out, "--property=EnvironmentFile="+envFile)
	}
	return out
}

// startArgs is the systemd-run argv of a run (the template the tests pin).
func (s systemdSupervisor) startArgs(u unitSpec) []string {
	args := []string{"--unit=" + u.Unit, "--description=ExponetDB engine run " + u.RunID, "--quiet", "--service-type=exec"}
	args = append(args, hardening(u.UID, u.GID)...)
	args = append(args, pathProperties(u.ReadWrite, u.Optional, u.Bind, u.EnvironmentFile)...)
	args = append(args,
		"--property=MemoryMax="+memoryMax[u.Purpose],
		"--property=RuntimeMaxSec="+strconv.Itoa(int(runtimeMax[u.Purpose].Seconds())),
		"--property=TimeoutStopSec="+strconv.Itoa(int(engineGrace.Seconds())),
		"--property=Restart=no",
		"--property=StandardOutput=null",
		"--property=StandardError=null",
		"--", s.helperBinary, "engine-run", "--run", u.RunID)
	return args
}

func (s systemdSupervisor) start(ctx context.Context, u unitSpec) error {
	if !runIDRE.MatchString(u.RunID) || u.Unit != UnitName(u.RunID) || runtimeMax[u.Purpose] == 0 {
		return errors.New("helper: invalid unit")
	}
	out, err := s.runner.Run(ctx, Command{Path: SystemdRun, Args: s.startArgs(u), Timeout: startBudget})
	if err != nil {
		return err
	}
	if out.ExitCode != 0 {
		return fmt.Errorf("helper: systemd-run exited %d", out.ExitCode)
	}
	return nil
}

func (s systemdSupervisor) states(ctx context.Context, units []string) (map[string]unitState, error) {
	got := map[string]unitState{}
	if len(units) == 0 {
		return got, nil
	}
	args := []string{"show", "--property=Id,LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainCode", "--"}
	args = append(args, units...)
	out, err := s.runner.Run(ctx, Command{Path: Systemctl, Args: args})
	if err != nil || out.ExitCode != 0 {
		return nil, errors.New("helper: systemctl show failed")
	}
	blocks := parseShow(out.Stdout)
	for _, u := range units {
		b, ok := blocks[u]
		if !ok {
			return nil, errors.New("helper: systemctl show did not report a unit")
		}
		st := unitState{Loaded: b["LoadState"] == "loaded", ActiveText: bounded(b["ActiveState"], 32), Result: bounded(b["Result"], 32)}
		switch b["ActiveState"] {
		case "active", "activating", "deactivating", "reloading", "refreshing":
			st.Active = true
		}
		if n, err := strconv.Atoi(b["ExecMainStatus"]); err == nil && b["ExecMainCode"] != "0" && b["ExecMainCode"] != "" {
			n = max(-1, min(n, 255))
			st.ExitStatus = &n
		}
		got[u] = st
	}
	return got, nil
}

func (s systemdSupervisor) stop(ctx context.Context, unit string) error {
	out, err := s.runner.Run(ctx, Command{Path: Systemctl, Args: []string{"stop", "--no-block", "--", unit}})
	if err != nil {
		return err
	}
	if out.ExitCode != 0 {
		return errors.New("helper: systemctl stop failed")
	}
	return nil
}

// readArgs is the systemd-run argv of a catalog read as the engine user:
// pgBackRest 2.59 and later refuse most commands as root, and the helper has
// no network (PrivateNetwork=yes).
func readArgs(e execSpec) []string {
	timeout := e.Timeout
	if timeout <= 0 {
		timeout = runTimeout
	}
	args := []string{"--wait", "--pipe", "--quiet", "--collect", "--service-type=exec"}
	args = append(args, hardening(e.UID, e.GID)...)
	args = append(args, pathProperties(nil, e.Optional, e.Bind, e.EnvironmentFile)...)
	args = append(args,
		"--property=MemoryMax=512M",
		"--property=RuntimeMaxSec="+strconv.Itoa(max(1, int(timeout.Seconds())-5)),
		"--", e.Path)
	return append(args, e.Args...)
}

func (s systemdSupervisor) runAs(ctx context.Context, e execSpec) (Output, error) {
	if !engineBinary(e.Path) {
		return Output{}, errors.New("helper: binary not allowlisted")
	}
	return s.runner.Run(ctx, Command{Path: SystemdRun, Args: readArgs(e), Timeout: e.Timeout})
}

// engineBinary: the binaries a run or a read may execute as the engine user.
var postgresBinRE = regexp.MustCompile(`^/[A-Za-z0-9/_.-]+/(1[6-8])/bin/(pg_dump|pg_dumpall|pg_restore|pg_ctl|postgres)$`)

func engineBinary(p string) bool {
	return p == PgBackRest || p == Restic || (postgresBinRE.MatchString(p) && !strings.Contains(p, ".."))
}

// ----- binaries and the engine user -----

// checkBinary: a binary the helper names is a regular file owned by root,
// writable by root only, executable, with no symlink on its path.
func (h *Helper) checkBinary(path string) *Refusal {
	dirPath, name, err := fsafe.Split(path)
	if err != nil {
		return refuse(CodeNotConfigured, "an engine binary path is not a file path")
	}
	dir, err := fsafe.OpenDir(h.path(dirPath))
	if err != nil {
		return refuse(CodePreconditionFailed, "the engine %s is not installed safely", name)
	}
	defer dir.Close()
	info, err := dir.Lstat(name)
	if err != nil || info.Kind != fsafe.KindFile || info.UID != h.rootUID() || info.Mode&0o022 != 0 || info.Mode&0o111 == 0 {
		return refuse(CodePreconditionFailed, "the engine %s is not installed safely", name)
	}
	return nil
}

// postgresBin is the directory of a major's binaries.
func (h *Helper) postgresBin(major int) string {
	return h.paths().PostgresLib + "/" + strconv.Itoa(major) + "/bin"
}

// instanceMajor is the instance's PostgreSQL major: the local name's prefix,
// confirmed by the data directory's PG_VERSION, 16 to 18.
func (h *Helper) instanceMajor(dataDirectory, localName string) (int, *Refusal) {
	major, err := strconv.Atoi(localName[:2])
	if err != nil || major < 16 || major > 18 {
		return 0, refuse(CodePreconditionFailed, "the cluster's PostgreSQL major is not supported for backups")
	}
	dir, err := fsafe.OpenDir(h.path(dataDirectory))
	if err != nil {
		return 0, refuse(CodePreconditionFailed, "the data directory cannot be opened safely")
	}
	defer dir.Close()
	data, _, err := dir.ReadFile("PG_VERSION", 16)
	if err != nil || strings.TrimSpace(string(data)) != strconv.Itoa(major) {
		return 0, refuse(CodePreconditionFailed, "the data directory's PG_VERSION does not match the cluster's major")
	}
	return major, nil
}

func (h *Helper) engineUser(uid, gid int) (engineUser, *Refusal) {
	lookup := h.lookupUser
	if lookup == nil {
		lookup = func(uid int) (string, error) {
			u, err := user.LookupId(strconv.Itoa(uid))
			if err != nil {
				return "", err
			}
			return u.Username, nil
		}
	}
	name, err := lookup(uid)
	if err != nil || uid <= 0 || !regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`).MatchString(name) {
		return engineUser{}, refuse(CodePreconditionFailed, "the data directory's owner is not a system user the engine can run as")
	}
	return engineUser{Name: name, UID: uid, GID: gid}, nil
}

package journal

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// Record kinds of the job journal. Format 1 (Wave 5 until review finding F7)
// had the lifecycle kinds; format 2 adds the statement and its delivery.
const (
	KindAccepted  = "accepted"
	KindStarted   = "started"
	KindStep      = "step"
	KindCompleted = "completed"
	KindRejected  = "rejected"
	KindAbandoned = "abandoned"
	// KindInterrupted closes a job that started and was cut off by a crash or
	// a stop: its outcome is unknown, it is reported to the control plane and
	// never resumed (protocol.md §4.4).
	KindInterrupted = "interrupted"
	// KindStated records that the job's one signed statement is stored in the
	// result buffer: the sha256 of the exact stored bytes and the statement's
	// outcome (never the statement itself). It comes before the job's
	// terminal record, so a job is never terminal without its statement.
	KindStated = "stated"
	// KindDelivered records that the gateway acknowledged the statement
	// (accepted or duplicate); it is written before the statement is removed
	// from the buffer.
	KindDelivered = "delivered"
	// KindParked records that the gateway refused the statement for good; it
	// stays in the buffer, parked for the local operator.
	KindParked = "parked"
)

// Format is the journal format this release writes. Format 2 adds stated,
// delivered and parked records to format 1; it replays a format-1 journal.
// A release that knows only format 1 refuses a journal that holds any of
// the new kinds (journal_corrupt): a downgrade fails closed.
const Format = 2

// Retention is how long the journal keeps settled jobs (security.md §2.12).
const Retention = 90 * 24 * time.Hour

// journalFile and noncesFile are the agent's replay files in its journal
// directory.
const (
	journalFile = "journal.log"
	noncesFile  = "nonces.log"
)

// Accepted is what the journal records when a verified job is accepted.
type Accepted struct {
	JobID       string
	OperationID string
	Capability  string
	ArgsHash    string
	Nonce       string
	IssuedAt    string
	ExpiresAt   string
}

// InFlight is a job that started and has no completion: after a restart it is
// reported to the control plane and never resumed (protocol.md §4.4).
type InFlight struct {
	JobID    string
	LastStep int
	at       time.Time
}

// MaxInFlightReported caps the in-flight jobs hello and heartbeats report
// (the contract's limit); the most recent ones are reported.
const MaxInFlightReported = 64

// InterruptedReported is how long an interrupted job is still reported: as
// long as the nonce cache remembers it.
const InterruptedReported = NonceWindow

type job struct {
	state    string // the last lifecycle kind ("" while only stated)
	lastStep int
	// digest and outcome of the journaled statement ("" before it).
	digest, outcome string
	// settled is KindDelivered or KindParked once the statement left
	// delivery.
	settled string
	first   time.Time
	at      time.Time
	records []canon.Object
}

// position is where a job stands: its last lifecycle kind ("" before the
// first), then "+stated" once its statement is journaled, or "+delivered" or
// "+parked" once that statement was delivered or parked.
func (st *job) position() string {
	switch {
	case st == nil:
		return ""
	case st.settled != "":
		return st.state + "+" + st.settled
	case st.digest != "":
		return st.state + "+" + KindStated
	}
	return st.state
}

// Journal is the job journal.
type Journal struct {
	mu    sync.Mutex
	chain *chain
	jobs  map[string]*job
	now   func() time.Time
}

// ErrState: a record that the job's lifecycle does not allow (a bug in the
// caller, never written).
var ErrState = errors.New("journal: transition not allowed")

// allowed is the closed table of transitions, by position (see
// job.position): every record a journal may hold for a job standing there.
var allowed = map[string][]string{
	// Before the job's statement is journaled.
	"":           {KindAccepted, KindStated, KindRejected},
	KindAccepted: {KindStarted, KindStated, KindAbandoned},
	KindStarted:  {KindStep, KindStated, KindCompleted, KindInterrupted},
	KindStep:     {KindStep, KindStated, KindCompleted, KindInterrupted},
	// The statement is stored and journaled: only the terminal record of
	// where the job stood. A rejection is stated before its job has any
	// other record.
	"+stated":         {KindRejected},
	"accepted+stated": {KindAbandoned},
	// A started job without a step never ran: when its start record reached
	// the disk although the write failed, its statement is a rejection.
	"started+stated":        {KindCompleted, KindInterrupted, KindAbandoned},
	"step+stated":           {KindCompleted, KindInterrupted},
	"completed+stated":      {KindDelivered, KindParked},
	"rejected+stated":       {KindDelivered, KindParked},
	"abandoned+stated":      {KindDelivered, KindParked},
	"interrupted+stated":    {KindDelivered, KindParked},
	"completed+delivered":   {},
	"rejected+delivered":    {},
	"abandoned+delivered":   {},
	"interrupted+delivered": {},
	"completed+parked":      {},
	"rejected+parked":       {},
	"abandoned+parked":      {},
	"interrupted+parked":    {},
	// Terminal records of format 1, which had no statement record: nothing
	// follows (their statement is delivered as before, untracked).
	KindCompleted:   {},
	KindRejected:    {},
	KindAbandoned:   {},
	KindInterrupted: {},
}

// format1 are the transitions only a format-1 journal holds: a terminal
// record without the job's statement record. Replay accepts them, so that a
// journal of the previous release opens; this release never writes them.
var format1 = map[[2]string]bool{
	{"", KindRejected}:             true,
	{KindAccepted, KindAbandoned}:  true,
	{KindStarted, KindCompleted}:   true,
	{KindStarted, KindInterrupted}: true,
	{KindStep, KindCompleted}:      true,
	{KindStep, KindInterrupted}:    true,
}

func permitted(from, to string) bool {
	for _, k := range allowed[from] {
		if k == to {
			return true
		}
	}
	return false
}

// Outcomes a statement can have (contracts JobCompleteRequest.outcome).
var outcomes = map[string]bool{"succeeded": true, "failed": true, "canceled": true, "rejected": true}

var digestRE = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// matches reports whether a terminal record fits the job's journaled
// statement: a completion carries the statement's outcome (never a
// rejection), a rejection or an abandonment states rejected, an interruption
// states failed. A format-1 terminal (no statement) has nothing to match.
func (st *job) matches(kind string, r canon.Object) bool {
	if st == nil || st.digest == "" {
		return true
	}
	switch kind {
	case KindCompleted:
		return member(r, "outcome") == st.outcome && st.outcome != "rejected"
	case KindRejected, KindAbandoned:
		return st.outcome == "rejected"
	case KindInterrupted:
		return st.outcome == "failed"
	}
	return true
}

// check validates a record against the job's position: the transition, the
// statement's members, and a terminal record's fit to the statement.
func check(st *job, kind string, r canon.Object) error {
	from := st.position()
	if !permitted(from, kind) {
		return fmt.Errorf("%s after %q", kind, from)
	}
	if kind == KindStated && (!digestRE.MatchString(member(r, "digest")) || !outcomes[member(r, "outcome")]) {
		return errors.New("stated without a digest and an outcome")
	}
	if !st.matches(kind, r) {
		return fmt.Errorf("%s does not fit the statement (%s)", kind, st.outcome)
	}
	return nil
}

func (st *job) apply(kind string, r canon.Object, at time.Time) {
	switch kind {
	case KindStated:
		st.digest, st.outcome = member(r, "digest"), member(r, "outcome")
	case KindDelivered, KindParked:
		st.settled = kind
	case KindStep:
		v, _ := r.Get("index")
		n, _ := v.(canon.Number)
		st.lastStep = int(n)
		st.state = kind
	default:
		st.state = kind
	}
	st.at = at
	st.records = append(st.records, r)
}

// Init creates the agent's empty replay files (the journal and the nonce
// cache) in dir, each durably, and leaves a file that exists as it is.
// Enrollment calls it before anything else, so an enrolled node always has
// them; after that a missing file is lost replay state (ErrMissing).
func Init(dir string) error {
	for _, name := range []string{journalFile, noncesFile} {
		if err := createFile(filepath.Join(dir, name)); err != nil && !errors.Is(err, ErrExists) {
			return err
		}
	}
	return nil
}

// Present lists the agent's replay files that exist in dir.
func Present(dir string) ([]string, error) {
	var out []string
	for _, name := range []string{journalFile, noncesFile} {
		_, err := os.Lstat(filepath.Join(dir, name))
		switch {
		case err == nil:
			out = append(out, name)
		case !errors.Is(err, os.ErrNotExist):
			return nil, err
		}
	}
	return out, nil
}

// Open opens the job journal in dir; a missing journal is ErrMissing. Only
// the one running agent opens it for writing (the state directory lock,
// architecture.md §4).
func Open(dir string, now func() time.Time) (*Journal, error) {
	return open(dir, now, existing)
}

// OpenReadOnly reads the journal without changing it (the status command).
func OpenReadOnly(dir string, now func() time.Time) (*Journal, error) {
	return open(dir, now, readOnly)
}

func open(dir string, now func() time.Time, mode openMode) (*Journal, error) {
	j := &Journal{jobs: map[string]*job{}, now: now}
	c, err := openChain(filepath.Join(dir, journalFile), j.replay, mode)
	if err != nil {
		return nil, err
	}
	j.chain = c
	return j, nil
}

func (j *Journal) replay(r canon.Object) error {
	kind, id := member(r, "kind"), member(r, "jobId")
	at, err := time.Parse(time.RFC3339Nano, member(r, "at"))
	if err != nil || id == "" {
		return errors.New("record without time or job")
	}
	st := j.jobs[id]
	if err := check(st, kind, r); err != nil {
		return fmt.Errorf("%v for %s", err, id)
	}
	if st == nil {
		st = &job{first: at}
		j.jobs[id] = st
	}
	st.apply(kind, r, at)
	return nil
}

// Err reports a broken journal (journal_corrupt).
func (j *Journal) Err() error { return j.chain.err() }

// Known reports whether the journal has any record of the job (job_replayed).
func (j *Journal) Known(jobID string) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	_, ok := j.jobs[jobID]
	return ok
}

func (j *Journal) write(jobID, kind string, fields canon.Object) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := j.chain.err(); err != nil {
		return err
	}
	st := j.jobs[jobID]
	at := j.now().UTC()
	record := append(canon.Object{
		{Name: "kind", Value: canon.String(kind)},
		{Name: "jobId", Value: canon.String(jobID)},
		{Name: "at", Value: canon.String(at.Format(time.RFC3339Nano))},
	}, fields...)
	if err := check(st, kind, record); err != nil || format1[[2]string{st.position(), kind}] {
		if err == nil {
			err = fmt.Errorf("%s without the job's statement", kind)
		}
		return fmt.Errorf("%w: %v for %s", ErrState, err, jobID)
	}
	written, err := j.chain.append(record)
	if err != nil {
		return err
	}
	if st == nil {
		st = &job{first: at}
		j.jobs[jobID] = st
	}
	st.apply(kind, written, at)
	return nil
}

// Accept records a verified job before the agent acknowledges its start.
func (j *Journal) Accept(a Accepted) error {
	return j.write(a.JobID, KindAccepted, canon.Object{
		{Name: "operationId", Value: canon.String(a.OperationID)},
		{Name: "capability", Value: canon.String(a.Capability)},
		{Name: "argsHash", Value: canon.String(a.ArgsHash)},
		{Name: "nonce", Value: canon.String(a.Nonce)},
		{Name: "issuedAt", Value: canon.String(a.IssuedAt)},
		{Name: "expiresAt", Value: canon.String(a.ExpiresAt)},
	})
}

// Start records that execution begins; it is written before anything runs.
func (j *Journal) Start(jobID string) error { return j.write(jobID, KindStarted, nil) }

// Step records a finished step.
func (j *Journal) Step(jobID string, index int, name, state string) error {
	return j.write(jobID, KindStep, canon.Object{
		{Name: "index", Value: canon.Number(index)},
		{Name: "name", Value: canon.String(name)},
		{Name: "state", Value: canon.String(state)},
	})
}

// Stated records that the job's one statement is stored: digest is the
// sha256 of the exact stored bytes, outcome the statement's. It is written
// after the statement is durable and before the job's terminal record.
func (j *Journal) Stated(jobID, digest, outcome string) error {
	return j.write(jobID, KindStated, canon.Object{
		{Name: "digest", Value: canon.String(digest)},
		{Name: "outcome", Value: canon.String(outcome)},
	})
}

// Complete records the outcome of a started job whose statement is stated.
func (j *Journal) Complete(jobID, outcome string) error {
	return j.write(jobID, KindCompleted, canon.Object{{Name: "outcome", Value: canon.String(outcome)}})
}

// Reject records a job refused before execution, after its statement (the
// rejection) is stated. Only a job whose signature verified is recorded, so
// a forged envelope cannot occupy a job id.
func (j *Journal) Reject(jobID, reason string) error {
	return j.write(jobID, KindRejected, canon.Object{{Name: "reason", Value: canon.String(reason)}})
}

// Abandon records an accepted job that will never run (its start was never
// acknowledged, or it could not be recorded), after its statement is stated.
func (j *Journal) Abandon(jobID string) error { return j.write(jobID, KindAbandoned, nil) }

// Interrupt closes a job a crash or a stop cut off, after its statement is
// stated; it is never resumed.
func (j *Journal) Interrupt(jobID string) error { return j.write(jobID, KindInterrupted, nil) }

// Delivered records that the gateway acknowledged the job's statement; it is
// written before the statement is removed.
func (j *Journal) Delivered(jobID string) error { return j.write(jobID, KindDelivered, nil) }

// Parked records that the gateway refused the job's statement for good and
// it was parked for the local operator.
func (j *Journal) Parked(jobID string) error { return j.write(jobID, KindParked, nil) }

// Position is where a job stands in the journal.
type Position struct {
	JobID string
	// State is the last lifecycle kind ("" while only the statement of a
	// rejection is journaled).
	State string
	// Digest and Outcome are those of the journaled statement; "" when there
	// is none (an open job, or a terminal record of format 1).
	Digest, Outcome string
	// Settled is KindDelivered or KindParked once the statement left
	// delivery.
	Settled string
	// Capability is what the job was accepted for ("" if never accepted).
	Capability string
}

// Terminal reports whether the job's lifecycle ended.
func (p Position) Terminal() bool {
	switch p.State {
	case KindCompleted, KindRejected, KindAbandoned, KindInterrupted:
		return true
	}
	return false
}

func (j *Journal) positionLocked(id string, st *job) Position {
	p := Position{JobID: id, State: st.state, Digest: st.digest, Outcome: st.outcome, Settled: st.settled}
	for _, r := range st.records {
		if member(r, "kind") == KindAccepted {
			p.Capability = member(r, "capability")
		}
	}
	return p
}

// Position returns where a job stands; false for a job the journal does not
// know.
func (j *Journal) Position(jobID string) (Position, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	st := j.jobs[jobID]
	if st == nil {
		return Position{}, false
	}
	return j.positionLocked(jobID, st), true
}

// Unsettled lists, in job id order, every job the agent must settle at start
// (protocol.md §4.4): open jobs (accepted, started, with or without their
// statement) and terminal jobs whose statement is journaled but neither
// delivered nor parked. A settled job and a terminal job of format 1 are not
// listed.
func (j *Journal) Unsettled() []Position {
	j.mu.Lock()
	defer j.mu.Unlock()
	var out []Position
	for id, st := range j.jobs {
		if len(allowed[st.position()]) > 0 {
			out = append(out, j.positionLocked(id, st))
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].JobID < out[b].JobID })
	return out
}

// StepRecord is a step as the journal recorded it.
type StepRecord struct {
	Index       int
	Name, State string
	At          string
}

// Steps returns the steps journaled for a job, in order.
func (j *Journal) Steps(jobID string) []StepRecord {
	j.mu.Lock()
	defer j.mu.Unlock()
	st := j.jobs[jobID]
	if st == nil {
		return nil
	}
	var out []StepRecord
	for _, r := range st.records {
		if member(r, "kind") != KindStep {
			continue
		}
		index := 0
		if v, ok := r.Get("index"); ok {
			if n, ok := v.(canon.Number); ok {
				index = int(n)
			}
		}
		out = append(out, StepRecord{Index: index, Name: member(r, "name"), State: member(r, "state"), At: member(r, "at")})
	}
	return out
}

// ArgsHash returns the argsHash the job was accepted with ("" if the journal
// holds no accepted record for it).
func (j *Journal) ArgsHash(jobID string) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	if st := j.jobs[jobID]; st != nil {
		for _, r := range st.records {
			if member(r, "kind") == KindAccepted {
				return member(r, "argsHash")
			}
		}
	}
	return ""
}

// State returns the last lifecycle kind of a job ("" if unknown, or if only
// the statement of its rejection is journaled).
func (j *Journal) State(jobID string) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	if st := j.jobs[jobID]; st != nil {
		return st.state
	}
	return ""
}

// InFlight lists jobs that started and did not complete: the running one
// (also one whose statement is stored but whose completion could not be
// journaled) and those interrupted within InterruptedReported, the most
// recent MaxInFlightReported of them, in job id order.
func (j *Journal) InFlight() []InFlight {
	j.mu.Lock()
	defer j.mu.Unlock()
	now := j.now()
	var out []InFlight
	for id, st := range j.jobs {
		switch {
		case st.state == KindStarted || st.state == KindStep,
			st.state == KindInterrupted && now.Sub(st.at) < InterruptedReported:
			out = append(out, InFlight{JobID: id, LastStep: st.lastStep, at: st.at})
		}
	}
	sort.Slice(out, func(a, b int) bool {
		if !out[a].at.Equal(out[b].at) {
			return out[a].at.After(out[b].at)
		}
		return out[a].JobID > out[b].JobID
	})
	if len(out) > MaxInFlightReported {
		out = out[:MaxInFlightReported]
	}
	sort.Slice(out, func(a, b int) bool { return out[a].JobID < out[b].JobID })
	return out
}

// Stats summarizes the journal for agent.diagnostics.
type Stats struct {
	Jobs     int
	Bytes    int64
	OldestAt time.Time
}

// Stats returns the journal's size and age.
func (j *Journal) Stats() Stats {
	j.mu.Lock()
	defer j.mu.Unlock()
	s := Stats{Jobs: len(j.jobs)}
	for _, st := range j.jobs {
		if s.OldestAt.IsZero() || st.first.Before(s.OldestAt) {
			s.OldestAt = st.first
		}
	}
	j.chain.mu.Lock()
	s.Bytes = j.chain.size
	j.chain.mu.Unlock()
	return s
}

// Cutoff is the time before which compaction may forget: retention before the
// earlier of the host clock and the highest accepted issuedAt. The latter is
// signed by the worker, so moving the host clock forward never makes the
// agent forget a job whose envelope could still be replayed; a zero
// highestIssuedAt (no job accepted yet) forgets nothing.
func Cutoff(now, highestIssuedAt time.Time, retention time.Duration) time.Time {
	if highestIssuedAt.IsZero() {
		return time.Time{}
	}
	ref := now
	if highestIssuedAt.Before(ref) {
		ref = highestIssuedAt
	}
	return ref.Add(-retention)
}

// Compact drops settled jobs (a statement delivered or parked, or a terminal
// record of format 1) whose last record is older than the cutoff (see
// Cutoff) and rewrites the rest behind a checkpoint. A job that is open, or
// whose statement still waits for delivery, is always kept. When the
// rewritten file cannot be read back, the journal is broken (every job is
// refused) and keeps what it knew.
func (j *Journal) Compact(retention time.Duration, highestIssuedAt time.Time) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	cutoff := Cutoff(j.now(), highestIssuedAt, retention)
	ids := make([]string, 0, len(j.jobs))
	for id := range j.jobs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	type indexed struct {
		seq    float64
		record canon.Object
	}
	var ordered []indexed
	for _, id := range ids {
		st := j.jobs[id]
		settled := len(allowed[st.position()]) == 0
		if settled && st.at.Before(cutoff) {
			continue
		}
		for _, r := range st.records {
			v, _ := r.Get("seq")
			n, _ := v.(canon.Number)
			ordered = append(ordered, indexed{seq: float64(n), record: r})
		}
	}
	sort.Slice(ordered, func(a, b int) bool { return ordered[a].seq < ordered[b].seq })
	keep := make([]canon.Object, 0, len(ordered))
	for _, o := range ordered {
		keep = append(keep, o.record)
	}
	if err := j.chain.rewrite(keep, j.now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	// Replay the rewritten file so every job holds its re-chained records.
	path := j.chain.path
	if err := j.chain.close(); err != nil {
		j.chain = &chain{path: path, broken: fmt.Errorf("%w: close after compaction: %v", ErrCorrupt, err)}
		return j.chain.broken
	}
	fresh := &Journal{jobs: map[string]*job{}, now: j.now}
	c, err := openChain(path, fresh.replay, existing)
	if err != nil {
		j.chain = &chain{path: path, broken: fmt.Errorf("%w: reopen after compaction: %v", ErrCorrupt, err)}
		return j.chain.broken
	}
	j.chain, j.jobs = c, fresh.jobs
	return nil
}

// Close closes the journal file.
func (j *Journal) Close() error { return j.chain.close() }

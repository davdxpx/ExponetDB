package journal

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// journalFile and noncesFile are the agent's replay files in its journal
// directory.
const (
	journalFile = "journal.log"
	noncesFile  = "nonces.log"
)

// Record kinds of the job journal.
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
)

// Retention is how long the journal keeps terminal jobs (security.md §2.12).
const Retention = 90 * 24 * time.Hour

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
	state    string // the last lifecycle kind
	lastStep int
	first    time.Time
	at       time.Time
	records  []canon.Object
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

// allowed lists the lifecycle transitions; "" is a job the journal has not seen.
var allowed = map[string][]string{
	"":              {KindAccepted, KindRejected},
	KindAccepted:    {KindStarted, KindAbandoned},
	KindStarted:     {KindStep, KindCompleted, KindInterrupted},
	KindStep:        {KindStep, KindCompleted, KindInterrupted},
	KindCompleted:   {},
	KindRejected:    {},
	KindAbandoned:   {},
	KindInterrupted: {},
}

func permitted(from, to string) bool {
	for _, k := range allowed[from] {
		if k == to {
			return true
		}
	}
	return false
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
	from := ""
	if st != nil {
		from = st.state
	}
	if !permitted(from, kind) {
		return fmt.Errorf("%s after %q for %s", kind, from, id)
	}
	if st == nil {
		st = &job{first: at}
		j.jobs[id] = st
	}
	st.state, st.at = kind, at
	st.records = append(st.records, r)
	if kind == KindStep {
		v, _ := r.Get("index")
		n, _ := v.(canon.Number)
		st.lastStep = int(n)
	}
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
	st := j.jobs[jobID]
	from := ""
	if st != nil {
		from = st.state
	}
	if !permitted(from, kind) {
		return fmt.Errorf("%w: %s after %q for %s", ErrState, kind, from, jobID)
	}
	at := j.now().UTC()
	record := append(canon.Object{
		{Name: "kind", Value: canon.String(kind)},
		{Name: "jobId", Value: canon.String(jobID)},
		{Name: "at", Value: canon.String(at.Format(time.RFC3339Nano))},
	}, fields...)
	written, err := j.chain.append(record)
	if err != nil {
		return err
	}
	if st == nil {
		st = &job{first: at}
		j.jobs[jobID] = st
	}
	st.state, st.at = kind, at
	st.records = append(st.records, written)
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
	if err := j.write(jobID, KindStep, canon.Object{
		{Name: "index", Value: canon.Number(index)},
		{Name: "name", Value: canon.String(name)},
		{Name: "state", Value: canon.String(state)},
	}); err != nil {
		return err
	}
	j.mu.Lock()
	j.jobs[jobID].lastStep = index
	j.mu.Unlock()
	return nil
}

// Complete records the outcome of a started job.
func (j *Journal) Complete(jobID, outcome string) error {
	return j.write(jobID, KindCompleted, canon.Object{{Name: "outcome", Value: canon.String(outcome)}})
}

// Reject records a job refused before execution. Only a job whose signature
// verified is recorded, so a forged envelope cannot occupy a job id.
func (j *Journal) Reject(jobID, reason string) error {
	return j.write(jobID, KindRejected, canon.Object{{Name: "reason", Value: canon.String(reason)}})
}

// Abandon records an accepted job whose start the gateway never acknowledged;
// it is never executed.
func (j *Journal) Abandon(jobID string) error { return j.write(jobID, KindAbandoned, nil) }

// Recover runs once when the agent starts, before any job: every job left
// accepted (its start may or may not have been acknowledged, it never ran) is
// returned to be abandoned, and every job left started is closed as
// interrupted, unless stated reports its signed statement (stored before the
// completion is journaled): such a job ran to its end and is completed with
// that statement's outcome. Nothing is ever resumed.
func (j *Journal) Recover(stated func(jobID string) (outcome string, ok bool)) (unstarted, interrupted []string, err error) {
	j.mu.Lock()
	var accepted, started []string
	for id, st := range j.jobs {
		switch st.state {
		case KindAccepted:
			accepted = append(accepted, id)
		case KindStarted, KindStep:
			started = append(started, id)
		}
	}
	j.mu.Unlock()
	sort.Strings(accepted)
	sort.Strings(started)
	for _, id := range started {
		if stated != nil {
			if outcome, ok := stated(id); ok {
				if err := j.Complete(id, outcome); err != nil {
					return nil, nil, err
				}
				continue
			}
		}
		if err := j.write(id, KindInterrupted, nil); err != nil {
			return nil, nil, err
		}
		interrupted = append(interrupted, id)
	}
	return accepted, interrupted, nil
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

// State returns the last lifecycle kind of a job ("" if unknown).
func (j *Journal) State(jobID string) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	if st := j.jobs[jobID]; st != nil {
		return st.state
	}
	return ""
}

// InFlight lists jobs that started and did not complete: the running one and
// those interrupted within InterruptedReported, the most recent
// MaxInFlightReported of them, in job id order.
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

// Compact drops terminal jobs whose last record is older than the cutoff
// (see Cutoff) and rewrites the rest behind a checkpoint. Jobs that are not
// terminal are always kept. When the rewritten file cannot be read back, the
// journal is broken (every job is refused) and keeps what it knew.
func (j *Journal) Compact(retention time.Duration, highestIssuedAt time.Time) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	cutoff := Cutoff(j.now(), highestIssuedAt, retention)
	var keep []canon.Object
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
		terminal := len(allowed[st.state]) == 0
		if terminal && st.at.Before(cutoff) {
			continue
		}
		for _, r := range st.records {
			v, _ := r.Get("seq")
			n, _ := v.(canon.Number)
			ordered = append(ordered, indexed{seq: float64(n), record: r})
		}
	}
	sort.Slice(ordered, func(a, b int) bool { return ordered[a].seq < ordered[b].seq })
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

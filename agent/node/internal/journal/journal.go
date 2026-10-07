package journal

import (
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// Record kinds of the job journal.
const (
	KindAccepted  = "accepted"
	KindStarted   = "started"
	KindStep      = "step"
	KindCompleted = "completed"
	KindRejected  = "rejected"
	KindAbandoned = "abandoned"
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
}

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
	"":            {KindAccepted, KindRejected},
	KindAccepted:  {KindStarted, KindAbandoned},
	KindStarted:   {KindStep, KindCompleted},
	KindStep:      {KindStep, KindCompleted},
	KindCompleted: {},
	KindRejected:  {},
	KindAbandoned: {},
}

func permitted(from, to string) bool {
	for _, k := range allowed[from] {
		if k == to {
			return true
		}
	}
	return false
}

// Open opens the job journal in dir.
func Open(dir string, now func() time.Time) (*Journal, error) {
	j := &Journal{jobs: map[string]*job{}, now: now}
	c, err := openChain(filepath.Join(dir, "journal.log"), j.replay)
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

// State returns the last lifecycle kind of a job ("" if unknown).
func (j *Journal) State(jobID string) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	if st := j.jobs[jobID]; st != nil {
		return st.state
	}
	return ""
}

// InFlight lists jobs that started and did not complete, in job id order.
func (j *Journal) InFlight() []InFlight {
	j.mu.Lock()
	defer j.mu.Unlock()
	var out []InFlight
	for id, st := range j.jobs {
		if st.state == KindStarted || st.state == KindStep {
			out = append(out, InFlight{JobID: id, LastStep: st.lastStep})
		}
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

// Compact drops terminal jobs whose last record is older than the retention
// and rewrites the rest behind a checkpoint. Jobs that are not terminal are
// always kept.
func (j *Journal) Compact(retention time.Duration) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	cutoff := j.now().Add(-retention)
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
		return err
	}
	j.jobs = map[string]*job{}
	c, err := openChain(path, j.replay)
	if err != nil {
		return err
	}
	j.chain = c
	return nil
}

// Close closes the journal file.
func (j *Journal) Close() error { return j.chain.close() }

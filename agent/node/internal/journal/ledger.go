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

// Ledger is the root helper's record of the effects it performed
// (architecture.md §2, Phase 4): one hash-chained, synced line per effect,
// so a job id that had an effect is never given another one. Each record
// keeps the job's signed issuedAt and expiresAt: the helper's clock must not
// fall behind the highest issuedAt (the agent's rollback rule), and a record
// is dropped only long after its job expired, when the helper refuses that
// job by its window anyway.
type Ledger struct {
	mu      sync.Mutex
	chain   *chain
	effects map[string]*effects
	highest time.Time
	now     func() time.Time
}

type effects struct {
	ops       []string
	expiresAt time.Time
	records   []canon.Object
}

const kindEffect = "effect"

// Effect is one effect about to happen.
type Effect struct {
	JobID     string
	Op        string
	IssuedAt  time.Time
	ExpiresAt time.Time
}

// OpenLedger opens or creates the ledger file name in dir.
func OpenLedger(dir, name string, now func() time.Time) (*Ledger, error) {
	l := &Ledger{effects: map[string]*effects{}, now: now}
	c, err := openChain(filepath.Join(dir, name), l.replay, false)
	if err != nil {
		return nil, err
	}
	l.chain = c
	return l, nil
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func (l *Ledger) replay(r canon.Object) error {
	kind := member(r, "kind")
	id, op := member(r, "jobId"), member(r, "op")
	issued, err1 := time.Parse(time.RFC3339Nano, member(r, "issuedAt"))
	expires, err2 := time.Parse(time.RFC3339Nano, member(r, "expiresAt"))
	if kind != kindEffect || id == "" || op == "" || err1 != nil || err2 != nil {
		return errors.New("not an effect record")
	}
	l.add(id, op, issued, expires, r)
	return nil
}

func (l *Ledger) add(id, op string, issued, expires time.Time, r canon.Object) {
	e := l.effects[id]
	if e == nil {
		e = &effects{}
		l.effects[id] = e
	}
	e.ops = append(e.ops, op)
	e.records = append(e.records, r)
	if expires.After(e.expiresAt) {
		e.expiresAt = expires
	}
	if issued.After(l.highest) {
		l.highest = issued
	}
}

// Ops lists the effects recorded for a job, in order.
func (l *Ledger) Ops(jobID string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e := l.effects[jobID]; e != nil {
		return append([]string{}, e.ops...)
	}
	return nil
}

// HighestIssuedAt is the latest issuedAt of a job that had an effect.
func (l *Ledger) HighestIssuedAt() time.Time {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.highest
}

// Record writes an effect durably before it happens; a failed write leaves
// the effect undone (the caller refuses it).
func (l *Ledger) Record(e Effect) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	r, err := l.chain.append(canon.Object{
		{Name: "kind", Value: canon.String(kindEffect)},
		{Name: "jobId", Value: canon.String(e.JobID)},
		{Name: "op", Value: canon.String(e.Op)},
		{Name: "issuedAt", Value: canon.String(stamp(e.IssuedAt))},
		{Name: "expiresAt", Value: canon.String(stamp(e.ExpiresAt))},
		{Name: "at", Value: canon.String(stamp(l.now()))},
	})
	if err != nil {
		return err
	}
	l.add(e.JobID, e.Op, e.IssuedAt, e.ExpiresAt, r)
	return nil
}

// Compact drops the effects of jobs that expired before the cutoff
// min(now, highest issuedAt) - retention: signed time bounds it, so a clock
// set forward cannot drop a record whose job is still valid.
func (l *Ledger) Compact(retention time.Duration) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := Cutoff(l.now(), l.highest, retention)
	type indexed struct {
		seq    float64
		record canon.Object
	}
	var ordered []indexed
	dropped := false
	for _, e := range l.effects {
		if e.expiresAt.Before(cutoff) {
			dropped = true
			continue
		}
		for _, r := range e.records {
			v, _ := r.Get("seq")
			n, _ := v.(canon.Number)
			ordered = append(ordered, indexed{seq: float64(n), record: r})
		}
	}
	if !dropped {
		return nil
	}
	sort.Slice(ordered, func(a, b int) bool { return ordered[a].seq < ordered[b].seq })
	keep := make([]canon.Object, 0, len(ordered))
	for _, o := range ordered {
		keep = append(keep, o.record)
	}
	if err := l.chain.rewrite(keep, stamp(l.now())); err != nil {
		return err
	}
	path := l.chain.path
	highest, kept := l.highest, l.effects
	_ = l.chain.close()
	l.effects, l.highest = map[string]*effects{}, time.Time{}
	c, err := openChain(path, l.replay, false)
	if err != nil {
		// Fail closed: the ledger stays broken, every effect is refused, and
		// what was known stays known (Phase 4 review).
		l.chain = &chain{path: path, broken: fmt.Errorf("%w: reopen after compaction: %v", ErrCorrupt, err)}
		l.effects, l.highest = kept, highest
		return err
	}
	l.chain = c
	// The rollback rule keeps the highest issuedAt even when its record is gone.
	if highest.After(l.highest) {
		l.highest = highest
	}
	return nil
}

// Err reports a broken ledger.
func (l *Ledger) Err() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.chain.err()
}

// Close closes the ledger file.
func (l *Ledger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.chain.close()
}

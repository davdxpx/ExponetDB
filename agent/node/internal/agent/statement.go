package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/transport"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// A job's one signed statement (protocol.md §4.2) moves through the result
// buffer and the journal in a fixed order (protocol.md §4.4, review finding
// F7), each step synced before the next:
//
//	buffer Put → stated (sha256 of the stored bytes) → terminal record
//	→ sent → delivered (or parked) → buffer Remove
//
// A job is therefore never terminal without its statement, a statement is
// never removed before its delivery is journaled, and the bytes the buffer
// holds are the only ones ever sent for the job. A crash or a failed write
// stops the sequence where it is; the next start (recover) continues it from
// what is on disk and never signs a second statement for a job that has one.

// interruptedExcerpt is the excerpt of the statement of a job a crash or a
// stop cut off (failed, with the steps it journaled).
const interruptedExcerpt = "interrupted: the agent stopped while running this job; it is never resumed"

// errIntegrity: a stored statement differs from the digest its stated record
// holds; nothing is sent, nothing is regenerated, every job is refused.
var errIntegrity = errors.New("journal_corrupt: a stored statement does not match its journal record")

func digestOf(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// committed is how far commit got.
type committed int

const (
	notStored  committed = iota // nothing stored: the job has no statement
	storedOnly                  // stored (maybe stated), the job is not closed
	closed                      // stored, stated and closed
)

// commit makes data the job's one statement: it stores it durably (never over
// an existing one), journals its digest (stated) and only then the terminal
// record that close writes. A failed step stops there, is logged and noted,
// and leaves the job open: the next start settles it from what was written.
func (a *Agent) commit(capability, jobID string, data []byte, outcome string, close func() error) committed {
	if err := a.buffer.Put(jobID, data); err != nil {
		a.log.Error("job statement not stored; the job stays open", "jobId", jobID, "error", err.Error())
		a.note(fmt.Errorf("statement of %s not stored: %v", jobID, err))
		return notStored
	}
	a.boundary(capability, "stored")
	if !a.stateAndClose(capability, jobID, digestOf(data), outcome, close) {
		return storedOnly
	}
	return closed
}

// stateAndClose journals a stored statement, then the job's terminal record.
func (a *Agent) stateAndClose(capability, jobID, digest, outcome string, close func() error) bool {
	if err := a.journal.Stated(jobID, digest, outcome); err != nil {
		a.log.Error("job statement stored but not journaled; the job stays open", "jobId", jobID, "error", err.Error())
		a.note(fmt.Errorf("statement of %s stored, not journaled: %v", jobID, err))
		return false
	}
	a.boundary(capability, "stated")
	return a.closeStated(capability, jobID, close)
}

// closeStated writes the terminal record of a job whose statement is stated.
func (a *Agent) closeStated(capability, jobID string, close func() error) bool {
	if err := close(); err != nil {
		a.log.Error("job statement journaled, job not closed", "jobId", jobID, "error", err.Error())
		a.note(fmt.Errorf("job %s stated, not closed: %v", jobID, err))
		return false
	}
	a.boundary(capability, "closed")
	return true
}

// heldStatement is what recovery reads of a stored statement.
type heldStatement struct {
	outcome, reason string
	interrupted     bool
}

func readStatement(jobID string, data []byte) (heldStatement, error) {
	var req protocol.JobCompleteRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return heldStatement{}, err
	}
	if req.JobID != jobID {
		return heldStatement{}, fmt.Errorf("it names job %s", req.JobID)
	}
	s := heldStatement{outcome: req.Outcome}
	if req.RejectionReason != nil {
		s.reason = *req.RejectionReason
	}
	s.interrupted = req.Outcome == "failed" && req.OutputExcerpt != nil && *req.OutputExcerpt == interruptedExcerpt
	switch {
	case req.Outcome == "rejected" && s.reason == "",
		req.Outcome != "rejected" && req.Outcome != "succeeded" && req.Outcome != "failed" && req.Outcome != "canceled":
		return heldStatement{}, fmt.Errorf("outcome %q", req.Outcome)
	}
	return s, nil
}

// closer returns the terminal record that fits where the job stands and what
// its statement says, or false when the statement cannot be this job's.
func (a *Agent) closer(p journal.Position, s heldStatement) (func() error, bool) {
	id := p.JobID
	switch {
	case p.State == "" && s.outcome == "rejected":
		return func() error { return a.journal.Reject(id, s.reason) }, true
	case p.State == journal.KindAccepted && s.outcome == "rejected":
		return func() error { return a.journal.Abandon(id) }, true
	case (p.State == journal.KindStarted || p.State == journal.KindStep) && s.interrupted:
		return func() error { return a.journal.Interrupt(id) }, true
	case (p.State == journal.KindStarted || p.State == journal.KindStep) && s.outcome != "rejected":
		return func() error { return a.journal.Complete(id, s.outcome) }, true
	}
	return nil, false
}

// quarantineUnclassified runs before recovery and before any delivery. A
// buffer without the ExportsClassified marker belongs to a node enrolled by
// a release before the Wave 5 correction F1, whose statements could carry
// host values it did not classify (configuration and role settings, pg_hba
// options, PostgreSQL error text). Every statement such a buffer holds is
// parked, never sent: only a bare rejection (a fixed reason, no result, no
// steps, no excerpt) stays pending, because it carries no host value. A
// parked statement is still its job's one statement: recovery states and
// closes the job from it, and the Control Plane reconciles the job from the
// host. Then the marker is written, so the pass runs once; a crash before it
// runs the pass again over what is still pending.
func (a *Agent) quarantineUnclassified() error {
	classified, err := a.buffer.Classified()
	if err != nil || classified {
		return err
	}
	parked := 0
	for _, id := range a.buffer.Pending() {
		data, err := a.buffer.Get(id)
		if err != nil {
			return fmt.Errorf("a statement held before the export correction cannot be read: %w", err)
		}
		if bareRejection(id, data) {
			continue
		}
		if err := a.buffer.Park(id); err != nil {
			return fmt.Errorf("a statement held before the export correction cannot be parked: %w", err)
		}
		parked++
	}
	if err := MarkClassified(a.buffer.dir); err != nil {
		return err
	}
	if parked > 0 {
		a.log.Warn("statements signed before the export correction are parked, never sent; the Control Plane "+
			"reconciles their jobs from the host (node-runbook.md)", "count", parked)
		a.note(fmt.Errorf("%d statements signed before the export correction were parked", parked))
	}
	return nil
}

// bareRejection reports whether a stored statement is a rejection that
// carries nothing but its fixed reason.
func bareRejection(jobID string, data []byte) bool {
	var req protocol.JobCompleteRequest
	if err := json.Unmarshal(data, &req); err != nil || req.JobID != jobID {
		return false
	}
	result := strings.TrimSpace(string(req.Result))
	return req.Outcome == "rejected" && req.RejectionReason != nil && len(req.Steps) == 0 &&
		req.OutputExcerpt == nil && (result == "" || result == "null")
}

// recover settles, before any job, what a crash, a stop or a failed write
// left unsettled (protocol.md §4.4). It never runs a capability and never
// resumes a job. A job whose statement is stored (pending or parked) keeps
// exactly those bytes: it is stated from them and closed as they say. A job
// without one gets its one statement, stored before its terminal record:
// failed ("interrupted", with the steps it journaled) for a job that
// started, rejected start_unacknowledged for one that never did. A statement
// whose digest no longer matches its stated record refuses every job; a
// stated statement that is gone is reported, never signed again. The caller
// holds the state directory lock.
func (a *Agent) recover() {
	for _, p := range a.journal.Unsettled() {
		if err := a.settle(p); err != nil {
			if errors.Is(err, errIntegrity) {
				a.breakJournal(err)
				return
			}
			a.log.Error("a job could not be settled; it stays as it is", "jobId", p.JobID, "error", err.Error())
			a.note(err)
		}
		if a.journal.Err() != nil {
			return // the journal cannot be written: the rest waits for the next start
		}
	}
	a.adoptOrphans()
}

// settle continues one job's sequence from what is on disk.
func (a *Agent) settle(p journal.Position) error {
	data, parked, held, err := a.buffer.Stored(p.JobID)
	if err != nil {
		return fmt.Errorf("settling %s: its statement cannot be read: %v", p.JobID, err)
	}
	switch {
	case p.Digest == "" && held:
		// Stored before a crash or a failed write cut off its stated record.
		return a.adopt(p, data, parked)
	case p.Digest == "":
		// Nothing stored: the job's one statement, now, before its
		// terminal record.
		return a.restate(p)
	case !held:
		return fmt.Errorf("anomaly: the statement of %s is journaled but neither held nor delivered; it is never signed again", p.JobID)
	case digestOf(data) != p.Digest:
		return fmt.Errorf("%w: %s", errIntegrity, p.JobID)
	case !p.Terminal():
		// Stated; a crash cut off its terminal record.
		s, err := readStatement(p.JobID, data)
		if err != nil {
			return fmt.Errorf("anomaly: the statement of %s cannot be read: %v", p.JobID, err)
		}
		close, ok := a.closer(p, s)
		if !ok {
			return fmt.Errorf("anomaly: the statement of %s (%s) does not fit the job (%s)", p.JobID, s.outcome, p.State)
		}
		if a.closeStated(p.Capability, p.JobID, close) && parked {
			return a.parked(p.JobID)
		}
	case parked:
		// Parked before a crash cut off its parked record.
		return a.parked(p.JobID)
	}
	// Terminal, stated and pending: the session delivers it.
	return nil
}

func (a *Agent) parked(jobID string) error {
	if err := a.journal.Parked(jobID); err != nil {
		return fmt.Errorf("statement of %s parked, not journaled: %v", jobID, err)
	}
	return nil
}

// adopt states a statement that is already stored (pending or parked),
// exactly as it is, and closes its job as it says.
func (a *Agent) adopt(p journal.Position, data []byte, parked bool) error {
	s, err := readStatement(p.JobID, data)
	if err != nil {
		return fmt.Errorf("anomaly: the statement held for %s cannot be read (%v); the job stays open", p.JobID, err)
	}
	close, ok := a.closer(p, s)
	if !ok {
		return fmt.Errorf("anomaly: the statement held for %s (%s) does not fit the job (%s); the job stays open", p.JobID, s.outcome, p.State)
	}
	if a.stateAndClose(p.Capability, p.JobID, digestOf(data), s.outcome, close) && parked {
		return a.parked(p.JobID)
	}
	return nil
}

// restate signs the one statement of a job that has none and commits it.
func (a *Agent) restate(p journal.Position) error {
	argsHash := a.journal.ArgsHash(p.JobID)
	var data []byte
	var outcome string
	var close func() error
	var err error
	switch p.State {
	case journal.KindAccepted:
		data, outcome, err = a.build(p.JobID, argsHash, "rejected", verify.StartUnacknowledged, nil, nil, nil)
		close = func() error { return a.journal.Abandon(p.JobID) }
	case journal.KindStarted, journal.KindStep:
		// Failed, with the steps it journaled, so the Control Plane learns
		// that this run is over and, from the effect step, whether the host
		// may have changed (control-plane.md §9.4).
		var steps []protocol.JobStep
		for _, s := range a.journal.Steps(p.JobID) {
			steps = append(steps, protocol.JobStep{Index: int64(s.Index), Name: s.Name, State: s.State, At: s.At})
		}
		msg := interruptedExcerpt
		data, outcome, err = a.build(p.JobID, argsHash, "failed", "", nil, steps, &msg)
		close = func() error { return a.journal.Interrupt(p.JobID) }
	default:
		return fmt.Errorf("anomaly: %s stands at %q without a statement", p.JobID, p.State)
	}
	if err != nil {
		return fmt.Errorf("statement of %s: %v", p.JobID, err)
	}
	a.commit(p.Capability, p.JobID, data, outcome, close)
	return nil
}

// adoptOrphans settles the statements the buffer holds for jobs the journal
// does not know: a rejection is stored before its first record, so a crash
// in between leaves one; it is stated and closed (the job becomes known, so
// a re-delivery never runs it). Anything else is reported and left alone.
func (a *Agent) adoptOrphans() {
	for _, id := range a.buffer.Pending() {
		p, known := a.journal.Position(id)
		switch {
		case known && p.Settled == journal.KindDelivered:
			// Delivered and journaled; a crash cut off the removal.
			if err := a.buffer.Remove(id); err != nil {
				a.note(err)
			}
		case known:
		default:
			data, err := a.buffer.Get(id)
			if err == nil {
				err = a.adopt(journal.Position{JobID: id}, data, false)
			}
			if err != nil {
				a.log.Error("a statement without a journal record stays in the buffer", "jobId", id, "error", err.Error())
				a.note(err)
			}
		}
		if a.journal.Err() != nil {
			return
		}
	}
}

// How a pending statement is delivered.
type delivery int

const (
	hold      delivery = iota // not now: its job is open or not journaled
	send                      // journaled: on acknowledgment, delivered, then removed
	untracked                 // a terminal record of format 1: on acknowledgment, removed
	once                      // the journal could not be opened: sent once per process, never removed
	drop                      // delivered and journaled: removed without sending
	settled                   // parked: never sent again
)

func (a *Agent) deliveryOf(jobID string) (delivery, journal.Position) {
	if a.journal == nil {
		return once, journal.Position{JobID: jobID}
	}
	p, known := a.journal.Position(jobID)
	switch {
	case !known:
		return hold, p
	case p.Settled == journal.KindDelivered:
		return drop, p
	case p.Settled == journal.KindParked:
		return settled, p
	case !p.Terminal():
		return hold, p
	case p.Digest == "":
		return untracked, p
	}
	return send, p
}

func (a *Agent) deliverBuffered(ctx context.Context) {
	for _, id := range a.buffer.Pending() {
		if ctx.Err() != nil {
			return
		}
		a.deliver(ctx, id)
	}
}

func (a *Agent) wasAcked(jobID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.acked[jobID]
}

func (a *Agent) markAcked(jobID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.acked[jobID] = true
}

// deliver sends a job's stored statement, byte for byte as stored, and
// settles it by the gateway's answer: acknowledged (accepted or duplicate) is
// journaled as delivered before the statement is removed; refused for good is
// parked for the local operator and journaled as parked.
func (a *Agent) deliver(ctx context.Context, jobID string) {
	if a.wasAcked(jobID) || a.unclassified != nil {
		return
	}
	mode, p := a.deliveryOf(jobID)
	switch mode {
	case hold, settled:
		return
	case drop:
		if err := a.buffer.Remove(jobID); err != nil {
			a.note(err)
		}
		return
	}
	data, err := a.buffer.Get(jobID)
	if err != nil {
		a.note(err)
		return
	}
	if mode == send && digestOf(data) != p.Digest {
		// Never sent, never replaced; not tried again by this process.
		a.markAcked(jobID)
		a.breakJournal(fmt.Errorf("%w: %s", errIntegrity, jobID))
		return
	}
	var resp protocol.JobCompleteResponse
	err = a.conn().Post(ctx, transport.JobEndpoint(jobID, "complete"), "JobCompleteRequest", json.RawMessage(data),
		"JobCompleteResponse", &resp, transport.MaxRequestBytes)
	var pe *transport.ProtocolError
	switch {
	case err == nil && (resp.Accepted || resp.Duplicate):
		a.boundary(p.Capability, "acknowledged")
		switch mode {
		case once:
			a.markAcked(jobID)
			return
		case send:
			if err := a.journal.Delivered(jobID); err != nil {
				// Kept: the next start sends the same bytes again and the
				// gateway answers duplicate.
				a.note(fmt.Errorf("delivery of %s acknowledged, not journaled: %v", jobID, err))
				a.markAcked(jobID)
				return
			}
			a.boundary(p.Capability, "delivered")
		}
		if err := a.buffer.Remove(jobID); err != nil {
			a.note(err)
		}
	case err == nil, errors.As(err, &pe) && !pe.Retryable, errors.Is(err, transport.ErrRequestInvalid):
		a.log.Error("completion refused by the gateway; parked for the local operator", "jobId", jobID)
		if err := a.buffer.Park(jobID); err != nil {
			a.note(err)
			return
		}
		if mode == send {
			if err := a.journal.Parked(jobID); err != nil {
				// The next start journals it from the parked statement.
				a.note(fmt.Errorf("statement of %s parked, not journaled: %v", jobID, err))
			}
		}
	default:
		a.note(fmt.Errorf("delivering %s: %v", jobID, err))
	}
}

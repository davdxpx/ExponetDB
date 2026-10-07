// Package verify is the agent's job verification pipeline (protocol.md
// §4.2): every check runs before anything executes, in the documented order,
// and the first failure names the rejection reason. It reads the journal and
// the nonce cache but writes neither; the caller records the decision.
package verify

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
)

// Rejection reasons (contracts JOB_REJECTION_REASONS).
const (
	SignatureInvalid      = nodecrypto.ReasonSignatureInvalid
	UnknownSigningKey     = nodecrypto.ReasonUnknownSigningKey
	EnvelopeInvalid       = "envelope_invalid"
	NodeMismatch          = "node_mismatch"
	NotYetValid           = "not_yet_valid"
	Expired               = "expired"
	ClockUntrusted        = "clock_untrusted"
	JournalCorrupt        = "journal_corrupt"
	JobReplayed           = "job_replayed"
	NonceReplayed         = "nonce_replayed"
	CapabilityUnsupported = "capability_unsupported"
	CapabilityDisabled    = "capability_disabled"
	ArgsInvalid           = "args_invalid"
	ArgsHashMismatch      = "args_hash_mismatch"
	PreconditionFailed    = "precondition_failed"
)

// MaxWindow is the longest validity window an envelope may have (ADR-0024 §4).
const MaxWindow = 60 * time.Minute

// Journal is what the pipeline reads of the job journal.
type Journal interface {
	Err() error
	Known(jobID string) bool
}

// Nonces is what the pipeline reads of the nonce cache.
type Nonces interface {
	Err() error
	Seen(nonce string) bool
}

// Capabilities answers whether the agent implements and enables name@major.
type Capabilities interface {
	Supported(key string) bool
	Enabled(key string) bool
}

// SealedField names an argument that must hold an ns1 value.
type SealedField struct {
	// Path is the argument path in the contract's notation, e.g. "steps[].verifier".
	Path  string
	Field string
}

// Verifier holds what the checks need.
type Verifier struct {
	InstallationID  string
	NodeID          string
	Trusted         []nodecrypto.TrustedJobKey
	Clock           clock.Clock
	HighestIssuedAt time.Time
	Journal         Journal
	Nonces          Nonces
	Capabilities    Capabilities
	Schema          *schema.Validator
	// Sealed returns the sealed fields of a capability (from the catalog).
	Sealed func(key string) []SealedField
	// NodeEncryptionSecret opens sealed fields; it is never logged.
	NodeEncryptionSecret []byte
	// Precondition checks the capability's local preconditions, e.g. that
	// the cluster's system identifier matches (step 7). nil accepts.
	Precondition func(key string, args canon.Object) error
}

// Job is a verified envelope's facts the caller needs.
type Job struct {
	JobID       string
	OperationID string
	NodeID      string
	Capability  string // name@major
	Name        string
	Major       int
	Args        canon.Object
	ArgsHash    string
	Nonce       string
	IssuedAt    time.Time
	NotBefore   time.Time
	ExpiresAt   time.Time
	Attempt     int
}

// Decision is the outcome of Verify. Reason is empty when the job may run.
// JobID is empty when the envelope has no readable job id (it cannot be
// answered). Signed reports whether the signature verified, which decides
// whether the job id may be journaled.
type Decision struct {
	JobID  string
	Reason string
	Signed bool
	Job    *Job
}

func str(o canon.Object, name string) string {
	v, _ := o.Get(name)
	s, _ := v.(canon.String)
	return string(s)
}

func ts(o canon.Object, name string) (time.Time, bool) {
	s := str(o, name)
	if !nodecrypto.IsTimestamp(s) {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	return t, err == nil
}

// Verify runs the pipeline over a parsed envelope.
func (v *Verifier) Verify(envelope canon.Object) Decision {
	jobID := str(envelope, "jobId")
	if !nodecrypto.IsID("job", jobID) {
		return Decision{Reason: EnvelopeInvalid}
	}
	reject := func(reason string, signed bool) Decision {
		return Decision{JobID: jobID, Reason: reason, Signed: signed}
	}

	// 1. Signature by a trusted key, the one its keyId names.
	if _, reason := nodecrypto.VerifyJobEnvelope(envelope, v.Trusted); reason != "" {
		return reject(reason, false)
	}
	// The envelope itself must match its schema (args are checked in step 6).
	if ref, ok := v.Schema.MessageRef("JobEnvelope"); !ok || v.Schema.Validate(ref, envelope) != nil {
		return reject(EnvelopeInvalid, true)
	}
	job, ok := facts(envelope)
	if !ok {
		return reject(EnvelopeInvalid, true)
	}

	// 2. Node binding.
	if job.NodeID != v.NodeID {
		return reject(NodeMismatch, true)
	}

	// 3. Clock and validity window.
	if err := clock.Check(v.Clock, v.HighestIssuedAt); err != nil {
		return reject(ClockUntrusted, true)
	}
	if !job.ExpiresAt.After(job.NotBefore) || job.ExpiresAt.Sub(job.NotBefore) > MaxWindow {
		return reject(Expired, true)
	}
	now := v.Clock.Now()
	if now.Before(job.NotBefore.Add(-clock.Tolerance)) {
		return reject(NotYetValid, true)
	}
	if now.After(job.ExpiresAt.Add(clock.Tolerance)) {
		return reject(Expired, true)
	}

	// 4. Replay: the journal, then the nonce cache.
	if v.Journal.Err() != nil || v.Nonces.Err() != nil {
		return reject(JournalCorrupt, true)
	}
	if v.Journal.Known(jobID) {
		return reject(JobReplayed, true)
	}
	if v.Nonces.Seen(job.Nonce) {
		return reject(NonceReplayed, true)
	}

	// 5. Capability and major supported and enabled.
	if !v.Capabilities.Supported(job.Capability) {
		return reject(CapabilityUnsupported, true)
	}
	if !v.Capabilities.Enabled(job.Capability) {
		return reject(CapabilityDisabled, true)
	}

	// 6. Arguments: schema and refinements, sealed values, argsHash.
	if v.Schema.ValidateArgs(job.Capability, job.Args) != nil {
		return reject(ArgsInvalid, true)
	}
	if v.Sealed != nil && !v.sealedOpen(job) {
		return reject(ArgsInvalid, true)
	}
	canonical, err := canon.Canonicalize(job.Args)
	if err != nil {
		return reject(ArgsInvalid, true)
	}
	sum := sha256.Sum256(canonical)
	if !nodecrypto.SameFingerprint("sha256:"+hex.EncodeToString(sum[:]), job.ArgsHash) {
		return reject(ArgsHashMismatch, true)
	}

	// 7. Local preconditions.
	if v.Precondition != nil && v.Precondition(job.Capability, job.Args) != nil {
		return reject(PreconditionFailed, true)
	}
	return Decision{JobID: jobID, Signed: true, Job: job}
}

// facts reads the envelope members (after the schema check).
func facts(e canon.Object) (*Job, bool) {
	capRaw, _ := e.Get("capability")
	capability, _ := capRaw.(canon.Object)
	majorRaw, _ := capability.Get("major")
	major, _ := majorRaw.(canon.Number)
	attemptRaw, _ := e.Get("attempt")
	attempt, _ := attemptRaw.(canon.Number)
	argsRaw, _ := e.Get("args")
	args, isObject := argsRaw.(canon.Object)
	issued, ok1 := ts(e, "issuedAt")
	notBefore, ok2 := ts(e, "notBefore")
	expires, ok3 := ts(e, "expiresAt")
	if !isObject || !ok1 || !ok2 || !ok3 {
		return nil, false
	}
	name := str(capability, "name")
	return &Job{
		JobID:       str(e, "jobId"),
		OperationID: str(e, "operationId"),
		NodeID:      str(e, "nodeId"),
		Capability:  name + "@" + strconv.Itoa(int(major)),
		Name:        name,
		Major:       int(major),
		Args:        args,
		ArgsHash:    str(e, "argsHash"),
		Nonce:       str(e, "nonce"),
		IssuedAt:    issued,
		NotBefore:   notBefore,
		ExpiresAt:   expires,
		Attempt:     int(attempt),
	}, true
}

// sealedOpen opens every sealed field under the job's context and discards
// the plaintext; a value that does not open is invalid arguments.
func (v *Verifier) sealedOpen(job *Job) bool {
	for _, f := range v.Sealed(job.Capability) {
		for _, value := range at(job.Args, f.Path) {
			if _, isNull := value.(canon.Null); isNull {
				continue
			}
			sealed, ok := nodecrypto.ParseNs1(value)
			if !ok {
				return false
			}
			pt, ok := nodecrypto.OpenNs1(v.NodeEncryptionSecret, nodecrypto.SealContext{
				InstallationID: v.InstallationID,
				NodeID:         job.NodeID,
				JobID:          job.JobID,
				OperationID:    job.OperationID,
				Capability:     job.Name,
				Major:          job.Major,
				Field:          f.Field,
			}, sealed)
			for i := range pt {
				pt[i] = 0
			}
			if !ok {
				return false
			}
		}
	}
	return true
}

// at returns the values at a path such as "steps[].verifier".
func at(value canon.Value, path string) []canon.Value {
	if path == "" {
		return []canon.Value{value}
	}
	head, rest, _ := strings.Cut(path, ".")
	each := strings.HasSuffix(head, "[]")
	o, ok := value.(canon.Object)
	if !ok {
		return nil
	}
	inner, ok := o.Get(strings.TrimSuffix(head, "[]"))
	if !ok {
		return nil
	}
	if !each {
		return at(inner, rest)
	}
	list, _ := inner.(canon.Array)
	var out []canon.Value
	for _, item := range list {
		out = append(out, at(item, rest)...)
	}
	return out
}

package helper

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/nodecrypto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// check verifies the job a request carries, as the agent did, but against
// the helper's own trust and clock: the envelope schema, the signature by a
// key the helper trusts, the node, the validity window, the capability the
// operation needs, the arguments and their hash.
func (h *Helper) check(op string, raw []byte) (*verify.Job, *Refusal) {
	spec, ok := operations[op]
	if !ok {
		return nil, refuse(CodeRequestInvalid, "unknown operation")
	}
	v, err := canon.Parse(raw)
	envelope, isObject := v.(canon.Object)
	if err != nil || !isObject {
		return nil, refuse(CodeJobInvalid, "the job is not a JSON object")
	}
	ref, ok := h.Schema.MessageRef("JobEnvelope")
	if !ok || h.Schema.Validate(ref, envelope) != nil {
		return nil, refuse(CodeJobInvalid, "the job does not match the envelope schema")
	}
	trust, err := h.trust()
	if err != nil {
		return nil, refuse(CodeNotConfigured, "the helper has no trust")
	}
	if _, reason := nodecrypto.VerifyJobEnvelope(envelope, trust.Trusted()); reason != "" {
		return nil, refuse(CodeJobInvalid, "the job signature does not verify: %s", reason)
	}
	job, ok := verify.Facts(envelope)
	if !ok {
		return nil, refuse(CodeJobInvalid, "the job cannot be read")
	}
	if job.NodeID != trust.NodeID {
		return nil, refuse(CodeJobInvalid, "the job is for another node")
	}
	if err := clock.Check(h.Clock, h.Ledger.HighestIssuedAt()); err != nil {
		return nil, refuse(CodeJobInvalid, "the host clock is not trusted")
	}
	now := h.Clock.Now()
	if !job.ExpiresAt.After(job.NotBefore) || job.ExpiresAt.Sub(job.NotBefore) > verify.MaxWindow ||
		now.Before(job.NotBefore.Add(-clock.Tolerance)) || now.After(job.ExpiresAt.Add(clock.Tolerance)) ||
		now.Before(job.IssuedAt.Add(-clock.Tolerance)) {
		return nil, refuse(CodeJobInvalid, "the job is outside its validity window")
	}
	if !spec.serves(job.Capability) {
		return nil, refuse(CodeOperationMismatch, "%s serves %s, not %s", op, spec.capability, job.Capability)
	}
	if h.Config.Disabled(job.Capability) {
		return nil, refuse(CodeOperationMismatch, "the operator disabled %s", job.Capability)
	}
	if h.Schema.ValidateArgs(job.Capability, job.Args) != nil {
		return nil, refuse(CodeJobInvalid, "the job arguments are invalid")
	}
	canonical, err := canon.Canonicalize(job.Args)
	if err != nil {
		return nil, refuse(CodeJobInvalid, "the job arguments are not canonical JSON")
	}
	sum := sha256.Sum256(canonical)
	if !nodecrypto.SameFingerprint("sha256:"+hex.EncodeToString(sum[:]), job.ArgsHash) {
		return nil, refuse(CodeJobInvalid, "the arguments do not match argsHash")
	}
	return job, nil
}

// admitEffect records an effect right before it happens, after the
// operation's read-only preconditions held: one effect per job, and the HBA
// restore only right after that job's write.
func (h *Helper) admitEffect(op string, job *verify.Job) *Refusal {
	if h.Ledger.Err() != nil {
		return refuse(CodeFailed, "the effect ledger is broken")
	}
	done := h.Ledger.Ops(job.JobID)
	switch {
	case op == OpHbaRestore:
		if len(done) != 1 || done[0] != OpHbaWrite {
			return refuse(CodeReplayed, "a restore follows only this job's write, once")
		}
	case len(done) > 0:
		return refuse(CodeReplayed, "the job already had its effect")
	}
	if err := h.Ledger.Record(journal.Effect{
		JobID: job.JobID, Op: op, IssuedAt: job.IssuedAt, ExpiresAt: job.ExpiresAt,
	}); err != nil {
		return refuse(CodeFailed, "the effect could not be recorded")
	}
	return nil
}

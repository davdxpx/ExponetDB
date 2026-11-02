package capabilities

import (
	"context"
	"errors"
	"fmt"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// Backups and restores (Wave 9 Part B, ADR-0037): the root helper answers
// them in full and verifies the signed job itself; the agent forwards the
// envelope. A start (backup.run, backup.verify, backup.expire,
// restore.execute, restore.verify), a cancel and a discard begin their effect
// before the helper call, so a cancel of the job after that point is never
// reported as canceled.

// mapped is the precondition of a backup capability that names a cluster:
// the operator mapped it. The helper reads the cluster's system identifier
// from pg_control itself, so a stopped source cluster can still be restored
// into scratch.
type mapped struct{ fixed }

func (m mapped) Precondition(args canon.Object) error {
	_, err := m.env.instance(args)
	return err
}

// helperEffect forwards an apply the helper performs: the effect begins
// before the call.
type helperEffect struct {
	precondition func(canon.Object) error
	f            fixed
	op           string
}

func (h helperEffect) Key() string                          { return h.f.key }
func (h helperEffect) EffectStep() string                   { return h.f.effect }
func (h helperEffect) Precondition(args canon.Object) error { return h.precondition(args) }

func (h helperEffect) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	if err := run.BeginEffect(); err != nil {
		return nil, err
	}
	out, err := h.f.env.Helper.Call(ctx, h.op, job.Envelope)
	if err != nil {
		return nil, startRefused(h.f.effect, err)
	}
	if err := step(run, h.f.effect); err != nil {
		return nil, err
	}
	return out, nil
}

// startRefused marks the helper's definite refusal of a run start (VC-061): the helper starts a
// run's unit last, so any refusal but outcome_unknown (systemd-run did not answer) or replayed
// (an earlier call may have started it) means no unit runs. The Control Plane reads the prefix
// (control-plane.md §9.4) and ends the operation at once instead of waiting for the run.
func startRefused(effect string, err error) error {
	var refusal *helperproto.ErrorBody
	if effect != "start_run" || !errors.As(err, &refusal) ||
		refusal.Code == helperproto.CodeOutcomeUnknown || refusal.Code == helperproto.CodeReplayed {
		return err
	}
	return fmt.Errorf("start_refused (%s): %s", refusal.Code, refusal.Message)
}

// mappedForward is a forwarded helper read whose job names a cluster.
type mappedForward struct {
	mapped
	op string
}

func (f mappedForward) Run(ctx context.Context, job *verify.Job, run *agent.Run) (canon.Object, error) {
	out, err := f.env.Helper.Call(ctx, f.op, job.Envelope)
	if err != nil {
		return nil, err
	}
	if err := step(run, "helper"); err != nil {
		return nil, err
	}
	return out, nil
}

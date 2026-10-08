package agent

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// diagnostics is agent.diagnostics@2: the agent's own health (@2: its
// lastErrors are the agent's own error texts, which never carry PostgreSQL's
// message text; Wave 5 correction F1).
type diagnostics struct{ a *Agent }

func (diagnostics) Key() string                     { return "agent.diagnostics@2" }
func (diagnostics) EffectStep() string              { return "" }
func (diagnostics) Precondition(canon.Object) error { return nil }

func (d diagnostics) Run(ctx context.Context, job *verify.Job, run *Run) (canon.Object, error) {
	j := d.a.journal.Stats()
	oldest := canon.Value(canon.Null{})
	if !j.OldestAt.IsZero() {
		oldest = canon.String(j.OldestAt.UTC().Format(time.RFC3339Nano))
	}
	errs := canon.Array{}
	for _, e := range d.a.lastErrors() {
		errs = append(errs, canon.String(e))
	}
	// The trusted job keys, the node-signed evidence of a job-key rotation
	// (control-plane.md §9.8).
	st := d.a.currentState()
	keys := canon.Array{}
	for _, k := range st.JobKeys {
		keys = append(keys, canon.String(k.KeyID))
	}
	result := canon.Object{
		{Name: "agentVersion", Value: canon.String(d.a.version)},
		{Name: "journal", Value: canon.Object{
			{Name: "entries", Value: canon.Number(j.Jobs)},
			{Name: "bytes", Value: canon.Number(j.Bytes)},
			{Name: "oldestAt", Value: oldest},
		}},
		{Name: "nonceCache", Value: canon.Object{
			{Name: "entries", Value: canon.Number(d.a.nonces.Len())},
			{Name: "bytes", Value: canon.Number(d.a.nonces.Bytes())},
		}},
		{Name: "bufferedResults", Value: canon.Number(d.a.buffer.Len())},
		{Name: "lastErrors", Value: errs},
		{Name: "jobKeys", Value: keys},
		{Name: "helperJobKeys", Value: d.helperKeys(ctx, job)},
		{Name: "gatewayUrl", Value: canon.String(st.GatewayURL)},
	}
	return result, run.Step("collect", "succeeded", nil)
}

// helperKeys are the root helper's own job keys, read with this signed job
// (the helper verifies it against them), or null when the helper cannot be
// asked or refuses: unknown, never assumed equal to the agent's.
func (d diagnostics) helperKeys(ctx context.Context, job *verify.Job) canon.Value {
	if d.a.o.Helper == nil || job == nil {
		return canon.Null{}
	}
	out, err := d.a.o.Helper.Call(ctx, "trust.inspect", job.Envelope)
	if err != nil {
		d.a.note(err)
		return canon.Null{}
	}
	keys, ok := member(out, "jobKeys").(canon.Array)
	if !ok || len(keys) < 1 || len(keys) > 3 {
		return canon.Null{}
	}
	for _, k := range keys {
		if _, ok := k.(canon.String); !ok {
			return canon.Null{}
		}
	}
	return keys
}

// configUpdate is config.update@1: the agent-owned trust state only (job
// keys, gateway address), never the operator configuration (G5 record C8).
type configUpdate struct{ a *Agent }

func (configUpdate) Key() string        { return "config.update@1" }
func (configUpdate) EffectStep() string { return "write_state" }

func member(o canon.Object, name string) canon.Value { v, _ := o.Get(name); return v }

// next computes the trust state the arguments ask for, or an error when it
// would be invalid (no key, more than three, a key id with another public
// key, an invalid gateway). It moves toward the target set: a key already
// held is not added again and a key no longer held is not retired again, as
// the helper does, so a new job converges after a partial update.
func (c configUpdate) next(args canon.Object) (*state.State, error) {
	cur := c.a.currentState()
	next := *cur
	next.JobKeys = nil
	retire := map[string]bool{}
	for _, v := range asArray(member(args, "retireJobKeys")) {
		retire[string(asString(v))] = true
	}
	for _, k := range cur.JobKeys {
		if !retire[k.KeyID] {
			next.JobKeys = append(next.JobKeys, k)
		}
	}
	for _, v := range asArray(member(args, "addJobKeys")) {
		o, _ := v.(canon.Object)
		add := state.JobKey{KeyID: string(asString(member(o, "keyId"))), PublicKey: string(asString(member(o, "publicKey")))}
		present := false
		for _, k := range next.JobKeys {
			if k.KeyID == add.KeyID {
				if k.PublicKey != add.PublicKey {
					return nil, errors.New("config.update: names a held key id with another public key")
				}
				present = true
			}
		}
		if !present {
			next.JobKeys = append(next.JobKeys, add)
		}
	}
	if gw, ok := member(args, "gateway").(canon.Object); ok {
		next.GatewayURL = string(asString(member(gw, "url")))
		next.GatewayServerName = string(asString(member(gw, "serverName")))
	}
	if err := next.Validate(); err != nil {
		return nil, err
	}
	return &next, nil
}

func (c configUpdate) Precondition(args canon.Object) error {
	_, err := c.next(args)
	return err
}

func (c configUpdate) Run(ctx context.Context, job *verify.Job, run *Run) (canon.Object, error) {
	if err := run.Step("validate", "succeeded", nil); err != nil {
		return nil, err
	}
	return c.apply(ctx, job, run)
}

func asArray(v canon.Value) canon.Array { a, _ := v.(canon.Array); return a }
func asString(v canon.Value) canon.String {
	s, _ := v.(canon.String)
	return s
}

// apply passes the effect point, updates the root helper's trust and then
// swaps the agent's state (architecture.md §2): a failure leaves the helper
// trusting no key the agent does not. A new gateway address takes effect
// when the agent reconnects.
func (c configUpdate) apply(ctx context.Context, job *verify.Job, run *Run) (canon.Object, error) {
	next, err := c.next(job.Args)
	if err != nil {
		return nil, err
	}
	if err := run.BeginEffect(); err != nil {
		return nil, err
	}
	if c.a.o.Helper != nil {
		if _, err := c.a.o.Helper.Call(ctx, "trust.update", job.Envelope); err != nil {
			return nil, fmt.Errorf("the helper's trust was not updated: %w", err)
		}
		if err := run.Step("helper_trust", "succeeded", nil); err != nil {
			return nil, err
		}
	}
	if err := c.a.replaceState(next); err != nil {
		return nil, err
	}
	if err := run.Step("write_state", "succeeded", nil); err != nil {
		return nil, err
	}
	keys := canon.Array{}
	for _, k := range next.JobKeys {
		keys = append(keys, canon.String(k.KeyID))
	}
	return canon.Object{
		{Name: "gatewayUrl", Value: canon.String(next.GatewayURL)},
		{Name: "jobKeys", Value: keys},
	}, nil
}

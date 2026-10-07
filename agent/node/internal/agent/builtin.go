package agent

import (
	"context"
	"errors"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/state"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// diagnostics is agent.diagnostics@1: the agent's own health.
type diagnostics struct{ a *Agent }

func (diagnostics) Key() string                     { return "agent.diagnostics@1" }
func (diagnostics) EffectStep() string              { return "" }
func (diagnostics) Precondition(canon.Object) error { return nil }

func (d diagnostics) Run(_ context.Context, _ *verify.Job, run *Run) (canon.Object, error) {
	j := d.a.journal.Stats()
	oldest := canon.Value(canon.Null{})
	if !j.OldestAt.IsZero() {
		oldest = canon.String(j.OldestAt.UTC().Format(time.RFC3339Nano))
	}
	errs := canon.Array{}
	for _, e := range d.a.lastErrors() {
		errs = append(errs, canon.String(e))
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
	}
	return result, run.Step("collect", "succeeded", nil)
}

// configUpdate is config.update@1: the agent-owned trust state only (job
// keys, gateway address), never the operator configuration (G5 record C8).
type configUpdate struct{ a *Agent }

func (configUpdate) Key() string        { return "config.update@1" }
func (configUpdate) EffectStep() string { return "write_state" }

func member(o canon.Object, name string) canon.Value { v, _ := o.Get(name); return v }

// next computes the trust state the arguments ask for, or an error when it
// would be invalid (no key, more than three, a duplicate, an unknown key to
// retire, an invalid gateway).
func (c configUpdate) next(args canon.Object) (*state.State, error) {
	cur := c.a.currentState()
	next := *cur
	next.JobKeys = nil
	retire := map[string]bool{}
	for _, v := range asArray(member(args, "retireJobKeys")) {
		id := string(asString(v))
		found := false
		for _, k := range cur.JobKeys {
			found = found || k.KeyID == id
		}
		if !found {
			return nil, errors.New("config.update: retires a key the agent does not hold")
		}
		retire[id] = true
	}
	for _, k := range cur.JobKeys {
		if !retire[k.KeyID] {
			next.JobKeys = append(next.JobKeys, k)
		}
	}
	for _, v := range asArray(member(args, "addJobKeys")) {
		o, _ := v.(canon.Object)
		next.JobKeys = append(next.JobKeys, state.JobKey{
			KeyID: string(asString(member(o, "keyId"))), PublicKey: string(asString(member(o, "publicKey"))),
		})
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

func (c configUpdate) Run(_ context.Context, job *verify.Job, run *Run) (canon.Object, error) {
	if err := run.Step("validate", "succeeded", nil); err != nil {
		return nil, err
	}
	return c.apply(job.Args, run)
}

func asArray(v canon.Value) canon.Array { a, _ := v.(canon.Array); return a }
func asString(v canon.Value) canon.String {
	s, _ := v.(canon.String)
	return s
}

// apply passes the effect point and swaps the agent's state; a new gateway
// address takes effect when the agent reconnects.
func (c configUpdate) apply(args canon.Object, run *Run) (canon.Object, error) {
	next, err := c.next(args)
	if err != nil {
		return nil, err
	}
	if err := run.BeginEffect(); err != nil {
		return nil, err
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

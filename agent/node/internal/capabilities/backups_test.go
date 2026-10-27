package capabilities

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/agent"
	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// TestEffectStepsAreTheContracts: every capability's effect step is the
// contract's effectStep (a cancel after it is never reported canceled, and
// the Control Plane reads the steps by these names).
func TestEffectStepsAreTheContracts(t *testing.T) {
	data, err := os.ReadFile("../protocol/schema_gen.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Capabilities map[string]struct {
			EffectStep *string `json:"effectStep"`
			Path       string  `json:"path"`
		} `json:"x-exponetdb-capabilities"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	for _, c := range All(&Env{Config: &config.Config{}}) {
		want, ok := doc.Capabilities[c.Key()]
		if !ok {
			t.Errorf("%s is not in the contract", c.Key())
			continue
		}
		step := ""
		if want.EffectStep != nil {
			step = *want.EffectStep
		}
		if c.EffectStep() != step {
			t.Errorf("%s: effect step %q, the contract says %q", c.Key(), c.EffectStep(), step)
		}
	}
}

type recordingHelper struct {
	ops   []string
	begun []bool
	run   *agent.Run
	err   error
}

func (r *recordingHelper) Call(_ context.Context, op string, _ canon.Object) (canon.Object, error) {
	r.ops = append(r.ops, op)
	r.begun = append(r.begun, r.run.EffectPassed())
	return canon.Object{}, r.err
}

// TestBackupCapabilitiesForwardToTheHelper: the agent forwards the signed
// job; a start, a cancel and a discard pass their effect point first, the
// reads do not.
func TestBackupCapabilitiesForwardToTheHelper(t *testing.T) {
	cfg := &config.Config{Instances: []config.Instance{{LocalName: "17/main"}}}
	h := &recordingHelper{}
	e := &Env{Config: cfg, Helper: h}
	caps := map[string]agent.Capability{}
	for _, c := range All(e) {
		caps[c.Key()] = c
	}
	cluster := canon.Object{{Name: "cluster", Value: canon.Object{{Name: "localName", Value: canon.String("17/main")},
		{Name: "systemIdentifier", Value: canon.String("1")}}}}
	for key, want := range map[string]struct {
		op     string
		effect bool
	}{
		"backup.list@1":     {helperproto.OpBackupList, false},
		"backup.timers@1":   {helperproto.OpBackupTimers, false},
		"backup.run@1":      {helperproto.OpBackupRun, true},
		"backup.verify@1":   {helperproto.OpBackupVerify, true},
		"backup.expire@1":   {helperproto.OpBackupExpire, true},
		"run.status@1":      {helperproto.OpRunStatus, false},
		"run.cancel@1":      {helperproto.OpRunCancel, true},
		"restore.prepare@1": {helperproto.OpRestorePrepare, false},
		"restore.execute@1": {helperproto.OpRestoreExecute, true},
		"restore.verify@1":  {helperproto.OpRestoreVerify, true},
		"restore.discard@1": {helperproto.OpRestoreDiscard, true},
	} {
		c := caps[key]
		if c == nil {
			t.Fatalf("%s is not registered", key)
		}
		if err := c.Precondition(cluster); err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		run := agent.NewRun(c.EffectStep(), time.Now, nil)
		h.run, h.ops, h.begun = run, nil, nil
		if _, err := c.Run(context.Background(), &verify.Job{Capability: key}, run); err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		if len(h.ops) != 1 || h.ops[0] != want.op || h.begun[0] != want.effect {
			t.Fatalf("%s: ops %v effect-before-call %v", key, h.ops, h.begun)
		}
	}
	// An unmapped cluster is refused by the agent before the helper.
	other := canon.Object{{Name: "cluster", Value: canon.Object{{Name: "localName", Value: canon.String("16/x")},
		{Name: "systemIdentifier", Value: canon.String("1")}}}}
	if err := caps["backup.run@1"].Precondition(other); !errors.Is(err, ErrPrecondition) {
		t.Fatalf("unmapped: %v", err)
	}
	// A cancel before the effect point stops a start without calling the helper.
	run := agent.NewRun("start_run", time.Now, nil)
	run.Cancel()
	h.run, h.ops = run, nil
	if _, err := caps["backup.run@1"].Run(context.Background(), &verify.Job{}, run); !errors.Is(err, agent.ErrCanceled) || len(h.ops) != 0 {
		t.Fatalf("canceled start: %v %v", err, h.ops)
	}
}

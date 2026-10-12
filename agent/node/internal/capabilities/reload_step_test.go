package capabilities

import (
	"testing"

	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
)

// The Control Plane takes a statement that lists the effect step and then
// the contracts' reloadStep as proof of a reload for exactly that job,
// whatever its outcome (ADR-0025). The step this agent journals after
// reload returned must be that name, and every capability the contracts
// give a reload step must be one this agent implements with an effect step.
func TestReloadStepIsTheContracts(t *testing.T) {
	v, err := schema.Protocol()
	if err != nil {
		t.Fatal(err)
	}
	if got := v.ReloadStep("postgres.config.apply@2"); got != StepReload {
		t.Fatalf("postgres.config.apply@2 reloadStep = %q, want %q", got, StepReload)
	}
	implemented := map[string]string{}
	for _, c := range All(&Env{}) {
		implemented[c.Key()] = c.EffectStep()
	}
	for key := range implemented {
		step := v.ReloadStep(key)
		if step == "" {
			continue
		}
		if step != StepReload {
			t.Errorf("%s: reloadStep %q is not the step the agent journals (%q)", key, step, StepReload)
		}
		if implemented[key] == "" || implemented[key] == step {
			t.Errorf("%s: a reload step needs an effect step before it (effect %q)", key, implemented[key])
		}
	}
	if v.ReloadStep("postgres.config.inspect@2") != "" || v.ReloadStep("postgres.hba.apply@2") != "" {
		t.Fatal("only capabilities whose statement proves a reload carry a reload step")
	}
}

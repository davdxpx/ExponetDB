package agent

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/protocol"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// ErrCanceled is returned by a capability that stopped on a cancel request
// before its effect step; the job completes canceled.
var ErrCanceled = errors.New("canceled before the effect point")

// Capability is one typed, versioned operation of the catalog. It receives
// arguments that already passed the verification pipeline.
type Capability interface {
	// Key is name@major.
	Key() string
	// EffectStep is the step at which the host first changes (contracts
	// effectStep); "" for reads and plans.
	EffectStep() string
	// Precondition checks local facts before the job is accepted
	// (protocol.md §4.2 step 7); nil accepts.
	Precondition(args canon.Object) error
	// Run executes the job and returns its result (which must match the
	// capability's result schema).
	Run(ctx context.Context, job *verify.Job, run *Run) (canon.Object, error)
}

// Registry holds the capabilities this agent implements, filtered by the
// operator's configuration.
type Registry struct {
	caps   map[string]Capability
	config *config.Config
}

// NewRegistry registers capabilities.
func NewRegistry(cfg *config.Config, caps ...Capability) *Registry {
	r := &Registry{caps: map[string]Capability{}, config: cfg}
	for _, c := range caps {
		r.caps[c.Key()] = c
	}
	return r
}

// Supported reports whether the agent implements name@major.
func (r *Registry) Supported(key string) bool { _, ok := r.caps[key]; return ok }

// Enabled reports whether the operator left name@major on.
func (r *Registry) Enabled(key string) bool { return !r.config.Disabled(key) }

// Get returns a registered capability.
func (r *Registry) Get(key string) (Capability, bool) { c, ok := r.caps[key]; return c, ok }

// Reported lists the supported and enabled capabilities for hello.
func (r *Registry) Reported() []protocol.Capability {
	keys := make([]string, 0, len(r.caps))
	for k := range r.caps {
		if r.Enabled(k) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	out := make([]protocol.Capability, 0, len(keys))
	for _, k := range keys {
		name, major := splitKey(k)
		out = append(out, protocol.Capability{Name: name, Major: int64(major)})
	}
	return out
}

func splitKey(key string) (string, int) {
	for i := len(key) - 1; i >= 0; i-- {
		if key[i] == '@' {
			n := 0
			for _, c := range key[i+1:] {
				n = n*10 + int(c-'0')
			}
			return key[:i], n
		}
	}
	return key, 0
}

// Run is a job's execution context: steps, cancellation, effect point.
type Run struct {
	mu       sync.Mutex
	effect   string
	passed   bool
	canceled bool
	steps    []protocol.JobStep
	now      func() time.Time
	onStep   func(index int, name, state string) error
}

func (r *Run) stamp() string { return r.now().UTC().Format(time.RFC3339Nano) }

// Step records a finished step: journaled first, then visible to progress
// reports. A step named like the capability's effect step marks the effect
// point as passed even if the capability did not call BeginEffect, so a later
// cancel can never be reported as canceled.
func (r *Run) Step(name, state string, message *string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	index := len(r.steps)
	if r.effect != "" && name == r.effect {
		r.passed = true
	}
	if r.onStep != nil {
		if err := r.onStep(index, name, state); err != nil {
			return err
		}
	}
	r.steps = append(r.steps, protocol.JobStep{Index: int64(index), Name: name, State: state, At: r.stamp(), Message: message})
	return nil
}

// EffectPassed reports whether the effect point was passed (BeginEffect, or a
// step named like the effect step).
func (r *Run) EffectPassed() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.passed
}

// BeginEffect is called right before the capability changes the host. After
// it a cancel request no longer stops the job (ADR-0024 §5); before it, a
// cancel request returns ErrCanceled.
func (r *Run) BeginEffect() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.canceled {
		return ErrCanceled
	}
	r.passed = true
	return nil
}

// Cancel records a cancel request; it takes effect only before BeginEffect.
func (r *Run) Cancel() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.passed {
		r.canceled = true
	}
}

// Canceled reports a pending cancel request (before the effect point).
func (r *Run) Canceled() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.canceled && !r.passed
}

// Steps returns the steps so far.
func (r *Run) Steps() []protocol.JobStep {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]protocol.JobStep{}, r.steps...)
}

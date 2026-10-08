package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/clock"
	"github.com/davdxpx/ExponetDB/agent/node/internal/config"
	"github.com/davdxpx/ExponetDB/agent/node/internal/journal"
	"github.com/davdxpx/ExponetDB/agent/node/internal/schema"
	"github.com/davdxpx/ExponetDB/agent/node/internal/verify"
)

// The helper's own units (service.status reports them with the mapped
// PostgreSQL units).
const (
	AgentUnit  = "exponetdb-node.service"
	HelperUnit = "exponetdb-node-helper.service"
)

// DefaultStateDirectory holds the helper's effect ledger and staged TLS keys.
const DefaultStateDirectory = "/var/lib/exponetdb-node-helper"

// LedgerRetention is how long an effect is kept after its job expired.
const LedgerRetention = 7 * 24 * time.Hour

// Helper serves the operations. It holds no state of the agent's: its trust,
// ledger and staged keys are root's.
type Helper struct {
	// Config is the root-owned operator configuration (instances, agent user,
	// disabled capabilities).
	Config *config.Config
	// Schema is the embedded protocol schema.
	Schema *schema.Validator
	Clock  clock.Clock
	Ledger *journal.Ledger
	Runner Runner
	// TrustPath is the helper trust file; TrustOwner its required owner
	// (root in production).
	TrustPath  string
	TrustOwner int
	// StagingDirectory holds generated TLS keys until their rotation (root
	// only, 0700).
	StagingDirectory string
	// Root prefixes host paths in tests ("" in production); it never comes
	// from a request.
	Root string
	// DigestKey keys every file digest the helper exports and checks (kd1,
	// capabilities.md §6); it never leaves the helper's state directory.
	// Without it, no operation that exports or checks a file digest runs.
	DigestKey []byte

	// One request at a time: the effect admission and the file preconditions
	// are not raced by another request.
	mu sync.Mutex
}

func (h *Helper) trust() (*Trust, error) { return LoadTrust(h.TrustPath, h.TrustOwner) }

// path maps an operator-configured host path into Root (tests only).
func (h *Helper) path(p string) string { return h.Root + p }

type handler func(ctx context.Context, h *Helper, job *verify.Job) (canon.Object, *Refusal)

var handlers = map[string]handler{
	OpServiceStatus:       serviceStatus,
	OpServiceRestart:      serviceRestart,
	OpConfigPatchFragment: configPatchFragment,
	OpFilesDigest:         filesDigest,
	OpHbaWrite:            hbaWrite,
	OpHbaRestore:          hbaRestore,
	OpTLSGenerateKey:      tlsGenerateKey,
	OpTLSInstall:          tlsInstall,
	OpPackagesAudit:       packagesAudit,
	OpPackagesPlanUpdate:  packagesPlanUpdate,
	OpTrustUpdate:         trustUpdate,
	OpTrustInspect:        trustInspect,
	OpFailedUnits:         failedUnits,
	OpLogRead:             logRead,
}

// QueueWait bounds how long a request waits for the one before it: an
// effect never happens long after its caller gave up (Phase 4 review).
var QueueWait = 30 * time.Second

func (h *Helper) lock(ctx context.Context) bool {
	deadline := time.Now().Add(QueueWait)
	for !h.mu.TryLock() {
		if ctx.Err() != nil || time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}

// Handle serves one request. The response never carries file content,
// command output or request values beyond the operation's typed result.
func (h *Helper) Handle(ctx context.Context, data []byte) Response {
	if !h.lock(ctx) {
		return Response{V: Version, Error: &ErrorBody{Code: CodeFailed, Message: "the helper is busy; nothing was done"}}
	}
	defer h.mu.Unlock()
	result, refusal := h.handle(ctx, data)
	if refusal != nil {
		return Response{V: Version, Error: &ErrorBody{Code: refusal.Code, Message: refusal.Message}}
	}
	return Response{V: Version, Result: result}
}

func (h *Helper) handle(ctx context.Context, data []byte) (json.RawMessage, *Refusal) {
	// Strict JSON first (duplicate members, exact member names: encoding/json
	// would match {"OP": ...} case-insensitively), then the closed shape.
	v, err := canon.Parse(data)
	obj, isObject := v.(canon.Object)
	if err != nil || !isObject {
		return nil, refuse(CodeRequestInvalid, "the request is not strict JSON")
	}
	for _, m := range obj {
		if m.Name != "v" && m.Name != "op" && m.Name != "job" {
			return nil, refuse(CodeRequestInvalid, "the request is not %s", Version)
		}
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var req Request
	if err := dec.Decode(&req); err != nil || req.V != Version || len(req.Job) == 0 {
		return nil, refuse(CodeRequestInvalid, "the request is not %s", Version)
	}
	run, ok := handlers[req.Op]
	if !ok {
		return nil, refuse(CodeRequestInvalid, "unknown operation")
	}
	job, refusal := h.check(req.Op, req.Job)
	if refusal != nil {
		return nil, refusal
	}
	result, refusal := run(ctx, h, job)
	if refusal != nil {
		return nil, refusal
	}
	if operations[req.Op].effect && !contains(h.Ledger.Ops(job.JobID), req.Op) {
		// An effect operation that returned without passing its admission
		// is a defect, never a success.
		return nil, refuse(CodeFailed, "the effect was not admitted")
	}
	out, err := canon.Canonicalize(result)
	if err != nil {
		return nil, refuse(CodeFailed, "the result is not canonical JSON")
	}
	return out, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// decodeArgs reads the verified arguments into a typed value.
func decodeArgs(job *verify.Job, into any) *Refusal {
	data, err := canon.Canonicalize(job.Args)
	if err != nil {
		return refuse(CodeJobInvalid, "the job arguments are not canonical JSON")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return refuse(CodeJobInvalid, "the job arguments do not fit %s", job.Capability)
	}
	return nil
}

package helper

import (
	"fmt"

	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
)

// The protocol names, as the helper uses them.
const (
	Version               = helperproto.Version
	OpServiceStatus       = helperproto.OpServiceStatus
	OpServiceRestart      = helperproto.OpServiceRestart
	OpConfigPatchFragment = helperproto.OpConfigPatchFragment
	OpFilesDigest         = helperproto.OpFilesDigest
	OpHbaWrite            = helperproto.OpHbaWrite
	OpHbaRestore          = helperproto.OpHbaRestore
	OpTLSGenerateKey      = helperproto.OpTLSGenerateKey
	OpTLSInstall          = helperproto.OpTLSInstall
	OpPackagesAudit       = helperproto.OpPackagesAudit
	OpPackagesPlanUpdate  = helperproto.OpPackagesPlanUpdate
	OpTrustUpdate         = helperproto.OpTrustUpdate
	OpTrustInspect        = helperproto.OpTrustInspect
	OpFailedUnits         = helperproto.OpFailedUnits
	OpLogRead             = helperproto.OpLogRead
	OpBackupList          = helperproto.OpBackupList
	OpBackupTimers        = helperproto.OpBackupTimers
	OpBackupRun           = helperproto.OpBackupRun
	OpBackupVerify        = helperproto.OpBackupVerify
	OpBackupExpire        = helperproto.OpBackupExpire
	OpRunStatus           = helperproto.OpRunStatus
	OpRunCancel           = helperproto.OpRunCancel
	OpRestorePrepare      = helperproto.OpRestorePrepare
	OpRestoreExecute      = helperproto.OpRestoreExecute
	OpRestoreVerify       = helperproto.OpRestoreVerify
	OpRestoreDiscard      = helperproto.OpRestoreDiscard

	CodeRequestInvalid     = helperproto.CodeRequestInvalid
	CodeJobInvalid         = helperproto.CodeJobInvalid
	CodeOperationMismatch  = helperproto.CodeOperationMismatch
	CodeReplayed           = helperproto.CodeReplayed
	CodeNotConfigured      = helperproto.CodeNotConfigured
	CodePreconditionFailed = helperproto.CodePreconditionFailed
	CodeFailed             = helperproto.CodeFailed
	CodeUnsupported        = helperproto.CodeUnsupported
	CodeOutcomeUnknown     = helperproto.CodeOutcomeUnknown
)

type (
	Request   = helperproto.Request
	Response  = helperproto.Response
	ErrorBody = helperproto.ErrorBody
)

// operation: the capability whose signed job authorizes it (and the further
// capabilities whose jobs authorize a read operation), and whether it changes
// the host (recorded in the ledger before it happens).
type operation struct {
	capability string
	effect     bool
	also       []string
}

// serves reports whether a job of capability authorizes the operation.
func (o operation) serves(capability string) bool {
	if capability == o.capability {
		return true
	}
	for _, c := range o.also {
		if c == capability {
			return true
		}
	}
	return false
}

var operations = map[string]operation{
	OpServiceStatus:  {"service.status@1", false, nil},
	OpServiceRestart: {"postgres.restart@1", true, nil},
	// Wave 5 correction F1: the fragment is patched with the plan's changes
	// only, and every file digest is keyed by the helper (capabilities.md §6).
	OpConfigPatchFragment: {"postgres.config.apply@2", true, nil},
	OpFilesDigest: {"postgres.config.inspect@2", false,
		[]string{"postgres.config.plan@2", "postgres.hba.inspect@2"}},
	OpHbaWrite:           {"postgres.hba.apply@2", true, nil},
	OpHbaRestore:         {"postgres.hba.apply@2", true, nil},
	OpTLSGenerateKey:     {"postgres.tls.plan@1", true, nil},
	OpTLSInstall:         {"postgres.tls.rotate@1", true, nil},
	OpPackagesAudit:      {"packages.audit@1", false, nil},
	OpPackagesPlanUpdate: {"packages.plan_update@1", false, nil},
	OpTrustUpdate:        {"config.update@1", true, nil},
	// The helper's own job keys, read with the agent's diagnostics: the
	// evidence that a key change reached the helper too (control-plane.md §9.8).
	OpTrustInspect: {"agent.diagnostics@2", false, nil},
	OpFailedUnits:  {"system.health@1", false, nil},
	OpLogRead:      {"log.inspect@2", false, nil},
	// Wave 9 Part B (ADR-0037): a start records its run and starts the unit
	// (one effect per job); run.status writes only the helper's own result
	// record of a run it observed ending.
	OpBackupList:     {"backup.list@1", false, nil},
	OpBackupTimers:   {"backup.timers@1", false, nil},
	OpBackupRun:      {"backup.run@1", true, nil},
	OpBackupVerify:   {"backup.verify@1", true, nil},
	OpBackupExpire:   {"backup.expire@1", true, nil},
	OpRunStatus:      {"run.status@1", false, nil},
	OpRunCancel:      {"run.cancel@1", true, nil},
	OpRestorePrepare: {"restore.prepare@1", false, nil},
	OpRestoreExecute: {"restore.execute@1", true, nil},
	OpRestoreVerify:  {"restore.verify@1", true, nil},
	OpRestoreDiscard: {"restore.discard@1", true, nil},
}

// Capability names the capability whose job authorizes op ("" if unknown).
func Capability(op string) string { return operations[op].capability }

// Refusal is an operation's refusal with its code; the message names at
// most the configured local name, unit or capability, never file content,
// command output or other request values.
type Refusal struct {
	Code    string
	Message string
}

func (r *Refusal) Error() string { return r.Code + ": " + r.Message }

func refuse(code, format string, args ...any) *Refusal {
	return &Refusal{Code: code, Message: fmt.Sprintf(format, args...)}
}

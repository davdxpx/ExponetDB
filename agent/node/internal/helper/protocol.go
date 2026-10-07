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
	OpConfigWriteFragment = helperproto.OpConfigWriteFragment
	OpHbaWrite            = helperproto.OpHbaWrite
	OpHbaRestore          = helperproto.OpHbaRestore
	OpTLSGenerateKey      = helperproto.OpTLSGenerateKey
	OpTLSInstall          = helperproto.OpTLSInstall
	OpPackagesAudit       = helperproto.OpPackagesAudit
	OpPackagesPlanUpdate  = helperproto.OpPackagesPlanUpdate
	OpTrustUpdate         = helperproto.OpTrustUpdate

	CodeRequestInvalid     = helperproto.CodeRequestInvalid
	CodeJobInvalid         = helperproto.CodeJobInvalid
	CodeOperationMismatch  = helperproto.CodeOperationMismatch
	CodeReplayed           = helperproto.CodeReplayed
	CodeNotConfigured      = helperproto.CodeNotConfigured
	CodePreconditionFailed = helperproto.CodePreconditionFailed
	CodeFailed             = helperproto.CodeFailed
	CodeUnsupported        = helperproto.CodeUnsupported
)

type (
	Request   = helperproto.Request
	Response  = helperproto.Response
	ErrorBody = helperproto.ErrorBody
)

// operation: the capability whose signed job authorizes it, and whether it
// changes the host (recorded in the ledger before it happens).
type operation struct {
	capability string
	effect     bool
}

var operations = map[string]operation{
	OpServiceStatus:       {"service.status@1", false},
	OpServiceRestart:      {"postgres.restart@1", true},
	OpConfigWriteFragment: {"postgres.config.apply@1", true},
	OpHbaWrite:            {"postgres.hba.apply@1", true},
	OpHbaRestore:          {"postgres.hba.apply@1", true},
	OpTLSGenerateKey:      {"postgres.tls.plan@1", true},
	OpTLSInstall:          {"postgres.tls.rotate@1", true},
	OpPackagesAudit:       {"packages.audit@1", false},
	OpPackagesPlanUpdate:  {"packages.plan_update@1", false},
	OpTrustUpdate:         {"config.update@1", true},
}

// Capability names the capability whose job authorizes op ("" if unknown).
func Capability(op string) string { return operations[op].capability }

// Refusal is an operation's refusal with its code; the message never
// carries file content, command output or request values.
type Refusal struct {
	Code    string
	Message string
}

func (r *Refusal) Error() string { return r.Code + ": " + r.Message }

func refuse(code, format string, args ...any) *Refusal {
	return &Refusal{Code: code, Message: fmt.Sprintf(format, args...)}
}

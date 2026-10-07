// Package helperproto is the wire protocol between the node agent and its
// root helper, exponetdb.helper/v1 (architecture.md §2): one request per
// Unix stream connection, a 4-byte big-endian length then strict JSON each
// way. A request names an operation and carries the signed job envelope that
// authorizes it; nothing else.
package helperproto

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
)

// Version is the helper RPC protocol.
const Version = "exponetdb.helper/v1"

// MaxMessage bounds a request or a response.
const MaxMessage = 1 << 20

// The operations.
const (
	OpServiceStatus       = "service.status"
	OpServiceRestart      = "service.restart"
	OpConfigWriteFragment = "config.write_fragment"
	OpHbaWrite            = "hba.write"
	OpHbaRestore          = "hba.restore"
	OpTLSGenerateKey      = "tls.generate_key"
	OpTLSInstall          = "tls.install"
	OpPackagesAudit       = "packages.audit"
	OpPackagesPlanUpdate  = "packages.plan_update"
	OpTrustUpdate         = "trust.update"
)

// Request is one call: an operation and the signed job envelope it serves.
type Request struct {
	V   string          `json:"v"`
	Op  string          `json:"op"`
	Job json.RawMessage `json:"job"`
}

// Response carries exactly one of Result and Error.
type Response struct {
	V      string          `json:"v"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *ErrorBody      `json:"error,omitempty"`
}

// ErrorBody is a refusal: a code from the list below and a fixed message.
type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error codes.
const (
	CodeRequestInvalid     = "request_invalid"
	CodeJobInvalid         = "job_invalid"
	CodeOperationMismatch  = "operation_mismatch"
	CodeReplayed           = "replayed"
	CodeNotConfigured      = "not_configured"
	CodePreconditionFailed = "precondition_failed"
	CodeFailed             = "failed"
	CodeUnsupported        = "unsupported"
)

func (e *ErrorBody) Error() string { return "helper refused (" + e.Code + "): " + e.Message }

// WriteFrame writes a 4-byte big-endian length and the bytes.
func WriteFrame(w io.Writer, data []byte) error {
	if len(data) > MaxMessage {
		return errors.New("helper: message too large")
	}
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(data)))
	if _, err := w.Write(n[:]); err != nil {
		return err
	}
	_, err := w.Write(data)
	return err
}

// ReadFrame reads one frame of at most MaxMessage bytes.
func ReadFrame(r io.Reader) ([]byte, error) {
	var n [4]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint32(n[:])
	if size > MaxMessage {
		return nil, errors.New("helper: message too large")
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(r, data); err != nil {
		return nil, err
	}
	return data, nil
}

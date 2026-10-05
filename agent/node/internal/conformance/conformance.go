// Package conformance is the independent Go implementation of ExponetDB's
// frozen hash contracts:
//
//   - prefixed entity ids and bare migration ULIDs (domain-model.md §2);
//   - c1 executable-text canonicalization of SQL files (migration-bundles.md
//     §3, N1 to N5);
//   - the manifest projections and the apply checksum, verify, rollback,
//     bundle and source digests (N6, N7);
//   - the ls1 ledger state hash (ledger.md §3);
//   - the plan hash (operations-engine.md §3.1).
//
// It is written from the specification and the golden vectors in
// tooling/golden only, never from the TypeScript production code, so that the
// two implementations can check each other. It exists for tests: it is never
// linked into the agent binaries. Canonical JSON comes from package canon.
//
// Every refusal is an *Error whose Code is the reason code named by the
// specification.
package conformance

import "fmt"

// Error is a refusal with a stable reason code.
type Error struct {
	// Code is the reason code, for example "invalid_ulid", "nul" or
	// "unresolved_search_path".
	Code string
	// File names the bundle file ("up.sql", "verify.sql" or "down.sql") for
	// errors found in a SQL file of a bundle; it is empty otherwise.
	File string
	// Detail is a human-readable explanation. It is not part of the contract.
	Detail string
}

func (e *Error) Error() string {
	msg := "conformance: " + e.Code
	if e.File != "" {
		msg += " in " + e.File
	}
	if e.Detail != "" {
		msg += ": " + e.Detail
	}
	return msg
}

func refuse(code string, format string, args ...any) *Error {
	return &Error{Code: code, Detail: fmt.Sprintf(format, args...)}
}

package protocol

import _ "embed"

// Schema is the node protocol JSON Schema document (messages and capability
// arguments and results), generated from packages/contracts with the Go
// types; package schema validates against it.
//
//go:embed schema_gen.json
var Schema []byte

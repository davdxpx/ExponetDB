# Fixtures

Synthetic example messages and inputs that several implementations read (data
only, never imported as code). Unlike `tooling/golden`, fixtures are examples,
not frozen hash contracts: they change with the contract they illustrate.

| Directory | Used by |
|---|---|
| `node-protocol/` | contract tests in `packages/contracts` (schema validation) and the Go tests of the generated protocol types in `agent/node/internal/protocol` (strict decoding, round trip). File name = message name (`<Message>[.<variant>].json`). Signatures are placeholders, not real Ed25519 signatures. |

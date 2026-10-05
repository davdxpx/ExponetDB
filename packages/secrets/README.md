# @exponetdb/secrets

Envelope encryption of secrets
([secrets.md](../../exponetdb-docs/08-auth-and-security/secrets.md)). The
tables, grants and guards live in the Control Store bundle
`01M46KJ15RF3QGAA25E0VSAGFD_secrets-store`; this package holds the keyring,
the envelope format `se1` and the code that stores, reads and re-wraps.

## Owns

| Module | What |
|---|---|
| `keyring.ts` | strict parser of `exponetdb.keyring/v1`, loading from `EXPONETDB_KEYRING` or an owner-only `EXPONETDB_KEYRING_FILE`, key check values, `generateKeyringText` and `addKeyToKeyringText` (rotation step 1); key bytes stay in a module-private map |
| `context.ts` | the secret context (`sec_` id, purpose, subject, version) and the associated data of `se1` |
| `envelope.ts` | `seal`, `open`, `rewrap`: per-version data keys, AES-256-GCM with 96-bit random nonces, injectable randomness for golden vectors |
| `store.ts` | `createSecret`, `addSecretVersion`, `readSecret` (per-consumer tables from a fixed map), `rewrapBatch` (bounded, `SKIP LOCKED`, cursor, unreadable rows reported), `keyringStatus` (references, missing, mismatched, removable keys), `registerActiveKey` |

## Does not own

Which secrets exist and when they rotate (credential operations, Wave 4 and
later), scheduling of the re-wrap job and its audit event (the worker in
`apps/server`), the meaning of a secret's value.

## Allowed dependencies

`@exponetdb/kernel`, `@exponetdb/control-store`. Never `audit`,
`operations`, `policy`, `contracts` or `observability`; callers pass a
transaction and append their own audit event in it.

## Security properties

- Master keys never reach the Control Store, logs, errors, traces or audit:
  the store holds key ids and check values only; the keyring prints and
  serializes without keys; errors carry codes, key ids and entry indexes.
- Ciphertext is bound to secret id, purpose, subject and version; wrapped
  data keys to secret id, version and master key id. Copies, relabels and
  changed bytes fail to decrypt.
- Ciphertext tables are readable only by their consumers (PostgreSQL grants);
  rows are append-only; only the worker re-wraps, and only the wrap columns.

## Failure behavior

Every decryption failure is `secret_decrypt_failed` without detail; a key the
keyring lacks is `secret_key_unavailable`; a different key under a registered
id is `secret_key_mismatch`; an invalid or ambiguous keyring fails startup.
Re-wrap never stops on a damaged row: it reports it, and the old key stays
referenced until the row is dealt with.

## Tests

`bun run test`: `se1` golden vectors (`tooling/golden/secret-envelope.json`),
keyring refusals, tampering, substitution, wrong keys, nonce uniqueness,
property tests. `bun run test:integration` against PostgreSQL 17: grant
matrix per consumer and role, append-only rows, row substitution in the
database, rotation with concurrent re-wrap, and a scan of the whole Control
Store for key material and plaintext.

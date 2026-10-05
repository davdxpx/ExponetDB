# Secrets

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; Wave 2 implementation (§2.1, §2.2, §3, §4) accepted with G2 on 2026-10-05 |
| Applies to | Wave 2 (keyring, envelope, store), Wave 4 (credential store) |
| Read before | [`../03-database-model/credentials-and-roles.md`](../03-database-model/credentials-and-roles.md) |

## 1. What is secret

| Secret | Where it lives | Who can use it |
|---|---|---|
| ExponetDB's observer credentials (`exponetdb_observer`) | Control Store `secret_blobs_observer` (encrypted) | `worker`, `serve` (planning, fast staleness checks) |
| ExponetDB's other PostgreSQL credentials (reader, operator, migrator) | Control Store `secret_blobs_worker` (encrypted) | `worker` only |
| OAuth refresh/access tokens, authorization codes, API keys, session ids | Control Store, **hashes only** | validation only; plaintext never stored |
| TOTP secrets | Control Store `secret_blobs_auth`, encrypted | `serve` (login) |
| WebAuthn credential public keys | Control Store (not secret, integrity-protected) | `serve` |
| Job-signing private key | Control Store `secret_blobs_worker`, encrypted | `worker` |
| Agent issuing CA private key | Control Store `secret_blobs_gateway`, encrypted | `gateway` |
| Agent root CA private key | **offline** (owner's storage) after bootstrap | ceremony only |
| Backup encryption keys and repository credentials | sealed to the node agent's key; stored on the host by the agent; **a copy offline with the owner** | node agent; humans for disaster recovery |
| Master key(s) (KEK) | environment/secret file of the ExponetDB containers (Coolify secret), **not** in the Control Store | process roles that need to decrypt |
| Control Store passwords per process role | Coolify environment | each process role |

## 2. Envelope encryption

**[DECIDED]**

- Each secret is encrypted with its own random 256-bit **data key** using
  AES-256-GCM (96-bit random nonce). The data key is wrapped with the current
  **master key** (AES-256-GCM key wrap with a key id).
- **Associated data** binds the ciphertext to its context:
  `"exponetdb/secret/v1|" + secret_id + "|" + purpose + "|" + subject_id + "|" + version`
  (for example purpose `pg_credential`, subject the cluster and role). A ciphertext
  copied into another row fails to decrypt (substitution protection).
- Master keys are provided as a **keyring**: `EXPONETDB_KEYRING` (or a mounted
  file) with entries `{keyId, key (base64, 32 bytes), status: active|decrypt_only}`.
  Exactly one active key.
- Plaintext secrets exist only in the memory of the process that uses them, for
  the shortest possible time; never logged, never in error messages, never in
  traces, never in audit, never returned by any API (C-20). Logging libraries are
  wrapped with a denylist for known secret shapes.

### 2.1 Envelope format `se1`

**[DECIDED]** (Wave 2, `packages/secrets`.) A stored contract, pinned by the
golden vectors `tooling/golden/secret-envelope.json` (derived independently
with the Python `cryptography` package):

```
secret AAD   = "exponetdb/secret/v1|"   secret_id "|" purpose "|" subject_id "|" version
data key AAD = "exponetdb/data-key/v1|" secret_id "|" version "|" key_id
ciphertext   = AES-256-GCM(data key, nonce,      plaintext, secret AAD)   -- ciphertext || 16-byte tag
wrapped key  = AES-256-GCM(master key, wrap nonce, data key, data key AAD) -- 48 bytes
check value  = "hmac-sha256:" + hex(HMAC-SHA-256(master key, "exponetdb/master-key-check/v1"))
```

- The associated data is unambiguous: no field may contain `|` and the number
  of fields is fixed. `secret_id` is a `sec_` id; `purpose` a dotted
  lower-case name of at most 64 characters (`pg_credential`,
  `job_signing.key`); `subject_id` at most 256 characters of
  `[A-Za-z0-9_.:/@-]` (`cls_…/exponetdb_observer`; never secret itself);
  `version` a decimal integer from 1 to 2^31−1; `key_id` a lower-case token.
- Each secret version gets a fresh data key; both nonces are 96-bit random
  values. A data key encrypts exactly one plaintext, so nonce reuse under a
  data key cannot occur; under a master key, wraps use random nonces.
- The master key id is part of the data key AAD: a wrapped key relabeled with
  another id fails, like a ciphertext copied to another secret, version,
  purpose or subject.
- Plaintext is 1 to 65,536 bytes. Every decryption failure is
  `secret_decrypt_failed` without detail; a missing master key is
  `secret_key_unavailable` with the key id. Data keys are overwritten in
  memory after use.

### 2.2 Keyring

**[DECIDED]** (Wave 2) Format, parsed strictly (unknown or duplicate members,
non-canonical base64, keys that are not exactly 32 bytes, duplicate ids, and
anything but exactly one `active` key are refused; at most 16 keys):

```json
{"format": "exponetdb.keyring/v1",
 "keys": [{"keyId": "k2026b", "status": "active", "key": "<base64, 32 bytes>"},
          {"keyId": "k2026a", "status": "decrypt_only", "key": "<base64, 32 bytes>"}]}
```

It is read from `EXPONETDB_KEYRING` (inline) or `EXPONETDB_KEYRING_FILE` (a
file that group and others cannot read); setting both, or neither, fails
startup. Refusals name a code and an entry index, never the text.
`exponetdb keyring generate` writes a new keyring with one CSPRNG key
(preferably with `--output <file>`, created with mode 0600). The Control Store
holds only key ids and check values (`secrets.master_keys`): a process proves
its keyring matches the keys that wrapped the stored data keys, and a key under
a registered id that is not the registered key is refused
(`secret_key_mismatch`). An integration test scans every row of every
ExponetDB table for key material and plaintext.

## 3. Rotation

| Rotation | Procedure |
|---|---|
| Master key | add new key as `active`, old as `decrypt_only`; background job re-wraps all data keys (no secret re-encryption needed); remove old key after the job reports zero references; audited. **[DECIDED]** (Wave 2) The job runs in the worker in batches (at most 1,000 data keys per transaction, `FOR UPDATE SKIP LOCKED`, a cursor so that damaged rows cannot block it) and appends `secrets.rewrapped` in each batch's transaction; data keys that do not unwrap are reported and stay on their old key, which then stays referenced. Readiness fails when a data key references a key the keyring lacks; `exponetdb keyring status` lists references per key id and which `decrypt_only` keys are removable |
| Data keys | new version of a secret gets a new data key automatically |
| PostgreSQL credentials | `credential.rotate` operations ([credentials-and-roles.md §5](../03-database-model/credentials-and-roles.md#5-exponetdbs-own-credentials-lifecycle)) |
| Job-signing key | new key published to agents via signed `config.update` (signed with the old key), overlap period 7 days, then old key retired |
| Agent issuing CA | new intermediate from the offline root (ceremony), overlap |
| Session/CSRF secrets | rotate with deploy; sessions survive (ids are random, not derived) |

## 4. Separation

- Secret **metadata** (id, purpose, subject, version, state, timestamps) lives
  in `secrets` and is queryable by the processes that manage it.
- **Ciphertext** lives in one table per consumer, so that Control Store grants
  enforce who can decrypt what:

  | Table | Contents | `SELECT` granted to | `INSERT` granted to (Wave 2) |
  |---|---|---|---|
  | `secret_blobs_worker` | reader, operator and migrator credentials; job-signing key; backup repository credentials references | `exdb_worker` | `exdb_worker`; `exdb_serve` write-only (submission endpoints) |
  | `secret_blobs_observer` | observer credentials | `exdb_worker`, `exdb_serve` | `exdb_worker`, `exdb_serve` |
  | `secret_blobs_auth` | TOTP secrets | `exdb_serve` | `exdb_serve` |
  | `secret_blobs_gateway` | agent issuing CA key | `exdb_gateway` | `exdb_worker` write-only (operations) |

- **[DECIDED]** (Wave 2) `secrets.secret_versions` (metadata, append-only,
  one row per version; a version follows the latest and keeps its purpose,
  subject and consumer, else `EXS01`; the creating login is recorded by the
  database) and
  `secrets.data_keys` (wrapped keys) are readable by the three process roles
  and writable by `exdb_serve` and `exdb_worker`; only `exdb_worker` may
  update a data key, and only its wrap columns. A ciphertext row must belong
  to a version of the same consumer (`EXS02`). No role may update, delete or
  truncate any of these rows (the owner is refused by trigger);
  `exdb_audit_maint` has no access to the schema. Tests attempt every
  forbidden access as every role.

- The Web App and MCP can show that a credential exists, its version, rotation
  date and verification status. Never its value.
- Write-only submission endpoints (external cluster credentials, SCRAM
  verifiers) accept a value once and return only metadata.

## 5. Bootstrap secrets and Coolify

V1 secrets that live outside the Control Store are Coolify environment secrets of
the ExponetDB resource: the keyring, the Control Store connection strings per
role. Their backup is part of the Coolify backup (REOSA's HB3 covers Coolify
secrets in its restic backup) **and** an offline copy with the owner. Losing the
keyring means losing all encrypted secrets: the documented recovery is to rotate
every PostgreSQL credential through the node agent (which does not need the old
password) and re-enroll nothing (agent keys are on the hosts).

## 6. Future

**[PLANNED]** A central Exponet secrets service (or a KMS) can replace the
environment keyring through a `KeyProvider` interface (`wrap`, `unwrap`, key ids).
ExponetDB's data model does not change: only the wrapping of data keys moves.
This is prepared, not built ([OD-10](../00-product/open-decisions.md#od-10-future-identity-architecture) covers the broader identity question; secrets service is listed there as a related item).

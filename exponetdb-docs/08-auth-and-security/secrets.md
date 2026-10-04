# Secrets

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 2 (key loading), Wave 4 (credential store) |
| Read before | [`../03-database-model/credentials-and-roles.md`](../03-database-model/credentials-and-roles.md) |

## 1. What is secret

| Secret | Where it lives | Who can use it |
|---|---|---|
| ExponetDB's PostgreSQL credentials for managed clusters | Control Store `secrets` (encrypted) | `worker` (and `serve` never) |
| OAuth refresh/access tokens, authorization codes, API keys, session ids | Control Store, **hashes only** | validation only; plaintext never stored |
| TOTP secrets | Control Store, encrypted | `serve` (login) |
| WebAuthn credential public keys | Control Store (not secret, integrity-protected) | `serve` |
| Job-signing private key | Control Store, encrypted | `worker` |
| Agent issuing CA private key | Control Store, encrypted | `gateway` |
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

## 3. Rotation

| Rotation | Procedure |
|---|---|
| Master key | add new key as `active`, old as `decrypt_only`; background job re-wraps all data keys (no secret re-encryption needed); remove old key after the job reports zero references; audited |
| Data keys | new version of a secret gets a new data key automatically |
| PostgreSQL credentials | `credential.rotate` operations ([credentials-and-roles.md §5](../03-database-model/credentials-and-roles.md#5-exponetdbs-own-credentials-lifecycle)) |
| Job-signing key | new key published to agents via signed `config.update` (signed with the old key), overlap period 7 days, then old key retired |
| Agent issuing CA | new intermediate from the offline root (ceremony), overlap |
| Session/CSRF secrets | rotate with deploy; sessions survive (ids are random, not derived) |

## 4. Separation

- Secret **metadata** (id, purpose, subject, version, state, timestamps) is
  queryable by the processes that manage it; **ciphertext** is readable only by
  the database roles of the processes that decrypt (Control Store grants:
  `exdb_worker` for credentials and job key, `exdb_gateway` for the CA key,
  `exdb_serve` for TOTP secrets).
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

# ADR-0023: Audit chain hash `ac1`, enforced by the database

| | |
|---|---|
| Status | Proposed (Wave 2); confirmed or changed by the owner at G2 |
| Date | 2026-10-05 |
| Related | C-31; [`../../02-control-plane/audit.md` §4](../../02-control-plane/audit.md#4-immutability-and-integrity); [`../versioning.md`](../versioning.md); golden vectors `tooling/golden/audit-chain.json` |

## Context

The baseline of [`audit.md` §4](../../02-control-plane/audit.md#4-immutability-and-integrity)
described the chain as `hash = SHA-256(prevHash || JCS(event without hash))`.
That sketch leaves open what exactly is concatenated (separator, encoding,
which members are "the event"), so two implementations could disagree, and a
plain concatenation is ambiguous: a different split of the same bytes between
`prevHash` and the event gives the same hash. The first stored event makes the
construction a stored contract; it must be fixed, versioned and testable
before Wave 2 writes one.

A chain computed only by the application is also only as strong as the
application: a faulty or compromised writer with `INSERT` could append a
forged link or fork the chain, and verification would find it only later.

## Decision

1. **`ac1`**, a versioned construction with a domain separator and
   length-prefixed frames (the same framing style as `c1` N6):

   ```
   input = UTF8("exponetdb/audit-chain/ac1") LF
         + frame("prevHash", UTF8(prevHash))
         + frame("event",    UTF8(JCS(E)))
   frame(label, b) = UTF8(label) LF decimal(len(b)) LF b LF
   hash  = "sha256:ac1:" + lowercase hex(SHA-256(input))
   ```

   `E` is the event of `exponetdb.audit/v1` with exactly its members (no
   `hash`, no `prevHash`); for `seq` 1, `prevHash` is the genesis value
   `ac1:genesis:<installation id>`, which binds a chain to its installation.
   The input checks and their order are part of the contract
   ([`audit.md` §4.1](../../02-control-plane/audit.md#41-chain-hash-ac1)).
2. **Golden vectors** (`tooling/golden/audit-chain.json`), derived from the
   specification by an independent script, locked and append-only from the
   first commit like every golden file.
3. **The database enforces the chain.** The Control Store has a second,
   independent implementation of `ac1` in SQL (`audit.ac1`). A `BEFORE INSERT`
   trigger takes the chain lock, requires the next `seq`, the head's hash (or
   the genesis value) as `prev_hash`, a time not before the head's and not
   ahead of the database clock, recomputes `ac1` and compares the query
   columns with the event. An insert that fails any check fails, and so does
   the mutation it audits.
4. A change of the construction is **`ac2`**: new vectors, a new value prefix,
   both versions readable; stored hashes are never recomputed.

## Alternatives considered

- **Keep the concatenation sketch.** Rejected: ambiguous, no domain
  separation, not version-tagged.
- **Hash in the application only.** Rejected: the database is the last line
  of defense against a faulty writer; the cost is one SHA-256 per insert under
  a lock that already serializes writers.
- **Signed events or checkpoints now.** Deferred (`[PLANNED]` in `audit.md`
  §4): a signature needs a key held outside the Control Plane, which V1 does
  not have. Off-host checkpoint export covers the superuser threat for V1.

## Consequences

- Two implementations (TypeScript in `packages/audit`, SQL in the Control
  Store) must agree on every vector; integration tests run the vectors
  through the SQL function.
- Writers are serialized by one transaction-level advisory lock; audit writes
  are low volume, so the cost is acceptable for a linear, verifiable chain
  (C-31).
- The owner role and a superuser can still switch off triggers; only exported
  checkpoints detect a rewrite by them (see `audit.md` §4.4).

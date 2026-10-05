# ADR-0001: ExponetDB lives in its own repository

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-2 ([constitution](../../00-product/constitution.md#c-2-exponetdb-is-a-standalone-product)), [`../repositories-and-boundaries.md`](../repositories-and-boundaries.md) |

## Context

ExponetDB serves several Exponet products; REOSA is only the first consumer.
REOSA's repository already contains database diagnostics, an operations kernel
and an infrastructure register, and the Supabase fork contains reusable UI and
introspection code. Placing ExponetDB inside either would be faster at first.

## Decision

ExponetDB is a standalone product in its own repository (`davdxpx/ExponetDB`)
with its own releases, contracts and Control Store. It has **no** build,
runtime, workspace or submodule dependency on REOSA or on the Supabase fork.
Code adapted from the Supabase fork is copied natively into ExponetDB packages
with license notices (ADR-0017). REOSA consumes ExponetDB through the REST API and
`@exponetdb/sdk`.

## Alternatives considered

- **Package inside the REOSA monorepo.** Rejected: REOSA's release cadence,
  brand rules and tenant model would leak into a product meant for all Exponet
  products, and REOSA outages in CI or tooling would block ExponetDB.
- **Fork of Supabase Studio.** Rejected: Supabase's project-centric model, its
  platform API and branding do not fit a multi-target control plane; tracking
  upstream would dominate the work.

## Consequences

- Cross-repository changes (REOSA adopting bundles, SDK use) are coordinated by
  versioned contracts, not by shared code.
- A CI boundary check forbids imports and paths into the other repositories.
- Some code is written twice (for example statement redaction exists in REOSA);
  ExponetDB's version becomes the shared one through the SDK, not through
  imports.

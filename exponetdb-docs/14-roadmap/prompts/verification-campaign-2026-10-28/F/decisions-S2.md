# Open decisions raised by the backup and restore measurements (agent S2)

- **S2-D1:** should `backup.verify` compute WAL gaps itself (R1's decision D-R1-2 stands)?
- **S2-D2 (OD-60):** must a drill carry a data check (a count or checksum from the source) before `passed`? Is `amcheck: not_run` acceptable when it covers 1 of 7 databases?
- **S2-D3:** should drills be drivable from a headless CLI (a human OAuth session) or stay browser-only?

Not run by S2: PostgreSQL 16 and 18 repeats (the lab image has PostgreSQL 17 only); the product-reported achievable RPO (posix repositories are never counted off-host, so it needs an S3 pgBackRest repository); a 7.7 GB restic restore from S3; Control Plane-level checks of the deleted-stop-segment case; applying a drill from the CLI (needs a browser re-auth). The "second backup while a backup runs" test did not overlap and is PARTIAL.

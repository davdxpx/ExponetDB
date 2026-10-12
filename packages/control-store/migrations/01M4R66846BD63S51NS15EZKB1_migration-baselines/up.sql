-- After a verified migration the worker records the schema it verified as
-- the target's expected state (drift-detection.md §7). Snapshots and
-- baselines stay append-only and guarded (EXH02, EXH03); only the allowed
-- purpose and reason grow by one value.
ALTER TABLE observation.schema_snapshots
  DROP CONSTRAINT schema_snapshots_purpose_check,
  ADD CONSTRAINT schema_snapshots_purpose_check
    CHECK (purpose IN ('registration', 'drift_check', 'read', 'migration'));
ALTER TABLE observation.schema_baselines
  DROP CONSTRAINT schema_baselines_reason_check,
  ADD CONSTRAINT schema_baselines_reason_check
    CHECK (reason IN ('registration', 'drift_accept', 'migration'));

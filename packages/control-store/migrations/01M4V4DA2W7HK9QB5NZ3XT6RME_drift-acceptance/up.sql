-- A drift acceptance records the target's current complete snapshot as its
-- expected schema (drift-detection.md §5, §7; operations-engine.md §2,
-- `drift.accept`). The snapshot the worker takes for it is stored with its
-- own purpose, so the history says why it was taken. Snapshots and
-- baselines stay append-only and guarded (EXH02, EXH03); the baseline reason
-- `drift_accept` and the finding resolution `accepted` exist since the
-- observation bundle. Only the allowed purpose grows by one value.
ALTER TABLE observation.schema_snapshots
  DROP CONSTRAINT schema_snapshots_purpose_check,
  ADD CONSTRAINT schema_snapshots_purpose_check
    CHECK (purpose IN ('registration', 'drift_check', 'read', 'migration', 'drift_accept'));

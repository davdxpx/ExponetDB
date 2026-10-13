-- Audit filters by client and grant (audit.md §5). Owner: exdb_migrate.
-- The expressions are the ones the audit search compares with; the events
-- are small and few, so the brief SHARE lock of a plain CREATE INDEX is
-- taken over the concurrent build (not available on a partitioned table).
CREATE INDEX audit_events_client
  ON audit.audit_events (((event::jsonb -> 'client' ->> 'clientId')), seq)
  WHERE (event::jsonb -> 'client' ->> 'clientId') IS NOT NULL;
CREATE INDEX audit_events_grant
  ON audit.audit_events (((event::jsonb -> 'client' ->> 'grantId')), seq)
  WHERE (event::jsonb -> 'client' ->> 'grantId') IS NOT NULL;

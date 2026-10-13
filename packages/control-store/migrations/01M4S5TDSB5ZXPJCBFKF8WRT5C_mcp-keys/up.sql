-- The MCP endpoint's two keys (ADR-0027 §7): cursors and request state.
-- The table stays append-only and guarded; only the allowed purposes grow.
ALTER TABLE auth.installation_keys
  DROP CONSTRAINT installation_keys_purpose_check,
  ADD CONSTRAINT installation_keys_purpose_check
    CHECK (purpose IN ('audit.pseudonym_key', 'auth.rate_limit_key',
                       'mcp.cursor_key', 'mcp.request_state_key'));

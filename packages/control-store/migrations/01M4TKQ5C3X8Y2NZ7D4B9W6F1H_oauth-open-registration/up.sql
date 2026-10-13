-- Owner decision of 2026-10-13 (OD-5 revised, oauth.md §3): MCP clients
-- that identify themselves by a Client ID Metadata Document or register
-- through DCR may be approved automatically ("open" registration, the
-- installation's default), so a person only consents. The guard of
-- oauth.clients (bundle oauth-delegation, frozen) is replaced to allow it;
-- every other rule stays: an approval binds the current fingerprint, a
-- rejected or disabled client needs a person, first-party and service
-- clients are unchanged. The review mode of the application still records
-- every new client as pending.
CREATE OR REPLACE FUNCTION oauth.client_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  identity_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only expired DCR registrations that were never approved are removed (worker prune).
    -- Also (open mode) a DCR registration approved automatically that no
    -- grant, request or code names, a week after its registration (worker
    -- prune; the foreign keys refuse a client still in use).
    IF NOT ((OLD.registration = 'dcr' AND OLD.state IN ('pending', 'rejected') AND OLD.approved_at IS NULL
             AND OLD.state_changed_at < clock_timestamp() - interval '7 days')
            OR (OLD.registration = 'dcr' AND OLD.state = 'active' AND OLD.approved_by_identity_id IS NULL
                AND OLD.created_at < clock_timestamp() - interval '7 days')) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'only expired, never approved or unused automatically approved DCR registrations are removed';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.registration = 'first_party' AND current_user <> 'exdb_migrate' THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'first-party clients come only from the Control Store bundles';
    END IF;
    -- Owner decision 2026-10-13 (OD-5 revised): a CIMD or DCR client starts
    -- pending (review mode) or active by automatic approval (open mode): no
    -- approver, and the approved fingerprint is the one recorded.
    IF NEW.registration IN ('cimd', 'dcr') AND NOT (
         NEW.state = 'pending'
         OR (NEW.state = 'active' AND NEW.approved_by_identity_id IS NULL
             AND NEW.approved_fingerprint IS NOT DISTINCT FROM NEW.metadata_fingerprint)) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a CIMD or DCR client starts pending or automatically approved';
    END IF;
    IF NEW.registration = 'pre_registered' THEN
      SELECT i.kind INTO identity_kind FROM auth.identities i
       WHERE i.identity_id = NEW.service_identity_id AND i.state = 'active' FOR SHARE;
      IF identity_kind IS DISTINCT FROM 'service' OR NEW.state <> 'active'
         OR NEW.approved_by_identity_id IS DISTINCT FROM NEW.created_by_identity_id
         OR NEW.created_by_identity_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a service-account client belongs to an active service identity and is approved by its creator';
      END IF;
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.state_changed_at := NEW.created_at;
    IF NEW.state = 'active' THEN
      NEW.approved_at := NEW.created_at;
    ELSE
      NEW.approved_at := NULL;
      NEW.approved_fingerprint := NULL;
      NEW.approved_by_identity_id := NULL;
    END IF;
    NEW.pending_expires_at := CASE WHEN NEW.registration = 'dcr' AND NEW.state = 'pending'
                                   THEN NEW.created_at + interval '7 days' END;
    RETURN NEW;
  END IF;
  IF (NEW.client_id, NEW.external_id, NEW.registration, NEW.kind, NEW.token_endpoint_auth_method,
      NEW.service_identity_id, NEW.requester_hash, NEW.created_by_identity_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.client_id, OLD.external_id, OLD.registration, OLD.kind, OLD.token_endpoint_auth_method,
      OLD.service_identity_id, OLD.requester_hash, OLD.created_by_identity_id, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'client identity, registration, kind and authentication method are immutable';
  END IF;
  -- First-party clients are fixed by the bundles: outside a migration only
  -- their state and approval may change (disabling them is a kill switch).
  IF OLD.registration = 'first_party' AND current_user <> 'exdb_migrate'
     AND (NEW.display_name, NEW.redirect_uris, NEW.application_type, NEW.grant_types, NEW.metadata,
          NEW.metadata_fingerprint, NEW.approved_fingerprint, NEW.jwks)
         IS DISTINCT FROM
         (OLD.display_name, OLD.redirect_uris, OLD.application_type, OLD.grant_types, OLD.metadata,
          OLD.metadata_fingerprint, OLD.approved_fingerprint, OLD.jwks) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a first-party client changes only through a Control Store bundle';
  END IF;
  -- Security metadata never changes under the same fingerprint, so a change
  -- always needs the review (or, for a service client, the key replacement)
  -- that approves the new fingerprint.
  IF (NEW.redirect_uris, NEW.grant_types, NEW.application_type, NEW.jwks)
     IS DISTINCT FROM (OLD.redirect_uris, OLD.grant_types, OLD.application_type, OLD.jwks)
     AND NEW.metadata_fingerprint IS NOT DISTINCT FROM OLD.metadata_fingerprint THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'security metadata changes only with a new fingerprint';
  END IF;
  IF OLD.registration = 'dcr' AND (NEW.redirect_uris, NEW.grant_types, NEW.application_type, NEW.metadata_fingerprint)
     IS DISTINCT FROM (OLD.redirect_uris, OLD.grant_types, OLD.application_type, OLD.metadata_fingerprint) THEN
    RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a DCR registration never changes: a new registration is a new client';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state, NEW.state) IN (('pending', 'active'), ('pending', 'rejected'), ('rejected', 'active'),
                                       ('active', 'disabled'), ('active', 'pending'), ('disabled', 'active'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'client state transition not allowed';
    END IF;
    IF (OLD.state, NEW.state) = ('active', 'pending')
       AND NEW.metadata_fingerprint IS NOT DISTINCT FROM OLD.approved_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'a client returns to review only when its security metadata changed';
    END IF;
    IF NEW.state = 'active' THEN
      -- An approval binds the current fingerprint and names its approver;
      -- only a pending CIMD or DCR client may be approved automatically (no
      -- approver). A rejected or disabled client needs a person.
      IF NEW.approved_fingerprint IS DISTINCT FROM NEW.metadata_fingerprint
         OR (NEW.approved_by_identity_id IS NULL
             AND NOT (OLD.state = 'pending' AND OLD.registration IN ('cimd', 'dcr'))) THEN
        RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'an approval names its approver and binds the current fingerprint';
      END IF;
      NEW.approved_at := clock_timestamp();
    END IF;
    NEW.state_changed_at := clock_timestamp();
    NEW.pending_expires_at := NULL;
  ELSIF (NEW.approved_fingerprint, NEW.approved_by_identity_id, NEW.approved_at, NEW.state_changed_at, NEW.pending_expires_at)
        IS DISTINCT FROM
        (OLD.approved_fingerprint, OLD.approved_by_identity_id, OLD.approved_at, OLD.state_changed_at, OLD.pending_expires_at) THEN
    -- An administrator replaces the keys of an active service-account client:
    -- the new fingerprint is approved in the same change and the client stays
    -- active (key rotation must not end its grants). Nothing else may touch
    -- approval data without a state change.
    -- Or (open mode, owner decision 2026-10-13) an active CIMD client whose
    -- document changed is approved again automatically with its new
    -- fingerprint.
    IF NOT ((OLD.registration = 'pre_registered' AND OLD.state = 'active'
             AND NEW.approved_fingerprint = NEW.metadata_fingerprint
             AND NEW.metadata_fingerprint IS DISTINCT FROM OLD.metadata_fingerprint
             AND NEW.approved_by_identity_id IS NOT NULL
             AND EXISTS (SELECT FROM auth.identities i WHERE i.identity_id = NEW.approved_by_identity_id
                          AND i.kind = 'human' AND i.state = 'active')
             AND (NEW.state_changed_at, NEW.pending_expires_at) IS NOT DISTINCT FROM (OLD.state_changed_at, OLD.pending_expires_at))
            OR (OLD.registration = 'cimd' AND OLD.state = 'active'
                AND NEW.approved_fingerprint = NEW.metadata_fingerprint
                AND NEW.metadata_fingerprint IS DISTINCT FROM OLD.metadata_fingerprint
                AND NEW.approved_by_identity_id IS NULL
                AND (NEW.state_changed_at, NEW.pending_expires_at) IS NOT DISTINCT FROM (OLD.state_changed_at, OLD.pending_expires_at))) THEN
      RAISE EXCEPTION USING ERRCODE = 'EXO01', MESSAGE = 'approval data changes only with an approval';
    END IF;
    NEW.approved_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION oauth.client_guard() FROM PUBLIC;
-- The worker prunes an unused automatically approved DCR registration only
-- when no authorization request names it (requests are pruned a day after
-- they end; a grant, a code, a token or a step-up exists only with a grant).
GRANT SELECT (client_id) ON oauth.authorization_requests TO exdb_worker;
GRANT SELECT (approved_by_identity_id, created_at) ON oauth.clients TO exdb_worker;

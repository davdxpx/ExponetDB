-- Gateway admission of completions (capabilities.md §6, Wave 5 correction
-- F1). Owner: exdb_migrate. An agent of a release before the correction can
-- still finish a job of a major the correction retired that was handed out
-- before the Control Plane was updated; its result can carry host values the
-- agent did not classify. The gateway asks this function for the job's
-- capability and refuses such a statement before `nodes.complete` stores it.
-- The gateway already sees each job's capability in the envelope it hands
-- out; the function tells it nothing more, and only for the node whose
-- current certificate it presents.
CREATE SCHEMA node_admission AUTHORIZATION exdb_migrate;
REVOKE ALL ON SCHEMA node_admission FROM PUBLIC;
GRANT USAGE ON SCHEMA node_admission TO exdb_gateway;

CREATE FUNCTION node_admission.job_capability(p_node_id text, p_certificate bytea, p_job_id text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  capability text;
BEGIN
  PERFORM nodes.served_node(p_node_id, p_certificate, false);
  SELECT j.capability INTO capability FROM nodes.jobs j WHERE j.job_id = p_job_id AND j.node_id = p_node_id;
  RETURN capability;
END
$fn$;
REVOKE ALL ON FUNCTION node_admission.job_capability(text, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION node_admission.job_capability(text, bytea, text) TO exdb_gateway;

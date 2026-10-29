source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
cat > $RH/drift.sql <<'SQL'
-- out-of-band changes by a developer with psql (the rehearsal's drift)
GRANT SELECT ON public.api_keys TO PUBLIC;
CREATE FUNCTION public.rh_drift_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.role := lower(NEW.role); RETURN NEW; END $$;
CREATE TRIGGER rh_drift_lower_role BEFORE INSERT ON public.org_members FOR EACH ROW EXECUTE FUNCTION public.rh_drift_trg();
CREATE POLICY rh_drift_anon_read ON public.api_keys FOR SELECT TO anon USING (true);
ALTER TABLE public.organizations ADD COLUMN rh_drift_col text;
COMMENT ON TABLE public.organizations IS 'edited by hand';
SQL
runuser -u postgres -- env PGOPTIONS='-c role=lab_owner' psql -X -q -p 55417 -d lab_rhstg -v ON_ERROR_STOP=1 -f $RH/drift.sql && echo drift applied at $(date -u +%T)
TAIL=20 tm drift-check-oob exdb drift check lab/platform/rhstg
exdb_json drift check lab/platform/rhstg > $L/drift-oob.json
jq -r '.data.findings[]? // .data.items[]? | [.severity,.code,.summary] | @tsv' $L/drift-oob.json | head -20
jq -c '.data | {status, counts}' $L/drift-oob.json
TAIL=10 tm schema-diff exdb schema diff --help

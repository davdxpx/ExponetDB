. /srv/work/s3-infra/s3/lib.sh; s3_release new
echo "bundles the migration resource applied: "; psql_control -At -c "select migration_id||' '||name from control.schema_migrations where applied_seq > (select max(applied_seq)-3 from control.schema_migrations) order by applied_seq"
T="$(add_target s3serial$(date +%H%M) pg17 2>/dev/null)"
for v in "a|CREATE TABLE public.va (id serial PRIMARY KEY, name text NOT NULL);" "e|CREATE TABLE public.ve (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text);" "f|CREATE TABLE public.vf (id bigserial PRIMARY KEY);"; do
  k=${v%%|*}; sql=${v#*|}
  d=$(new_project nx$k); mkb "$d" "var-$k" <<<"$sql" >/dev/null
  mplan "$d" "$T" >/dev/null; mapply "$PLAN_ID" --wait >/dev/null
  echo "new release, variant $k ($sql): $(op_state "$OP_ID")"
  exdb operation show "$OP_ID" 2>&1 | grep -E "^MIGRATION|var-" | head -2
done

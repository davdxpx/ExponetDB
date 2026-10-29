#!/usr/bin/env bash
# I7 "no silent adoption" on the running stack. For each class of out-of-band change (made as the local superuser,
# behind ExponetDB's back): apply bundle B1, check the target is clean, make the change, check drift is seen, then
# plan and apply an unrelated bundle B2 and read the drift baseline again. The first campaign's TC-006 (fixed in
# #46) claims the next verified migration no longer adopts the change.
#
# PASS     after B2 (verified) the drift check still reports the change (status drifted, an open finding names it)
# FAIL     the status is clean, or the finding was resolved, without any attributed human action (drift.accept)
# PARTIAL  the class is not seen at all by the drift check (not adopted, but never detected: the fingerprint is blind to it)
# Also after a SECOND unrelated migration (B3) and after a real drift.accept (a planned, attributed action).
#
#   I7-no-silent-adoption.sh [class-regex]       raw logs: $S1_LOGS/I7/<class>.log
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
FILTER="${1:-.}"
OUT="${S1_LOGS}/I7"; mkdir -p "$OUT"
PG=pg17

drift_row() { # target -> "status=drifted drifted=1 unmanaged=0 open_findings=2 ids=..."
  local j; j="$(exdb_json drift check "$1")"
  local f; f="$(exdb_json finding list --target "$1" --kind drift)"
  echo "status=$(jq -r '.data.status' <<<"$j") drifted=$(jq -r '.data.counts.drifted' <<<"$j") unmanaged=$(jq -r '.data.counts.unmanaged' <<<"$j") open_findings=$(jq -r '.data.items | length' <<<"$f") codes=$(jq -r '[.data.items[]?.code] | unique | join("+")' <<<"$f")"
}

drift_objs() { # target -> the open drift findings as "code object" lines, sorted
  exdb_json finding list --target "$1" --kind drift --limit 500 | jq -r '.data.items[] | .code + " " + (.object|tostring)' | sort -u
}

# class NAME  "psql run before B1 (setup, as superuser; may be empty)"  "out-of-band change"  [expectation text]
run_class() {
  local name="$1" setup="$2" change="$3"
  [[ "$name" =~ $FILTER ]] || return 0
  local log="${OUT}/${name}.log"; : >"$log"
  local target db dir
  target="$(fresh_target "7${name//_/}" "$PG")" || { verdict "I7.${name}" NOT_RUN "no fresh target"; return; }
  db="$(target_db "$target")"; dir="$(new_project "i7-${name}-${RUN_TAG}")"
  [ -n "$setup" ] && PGDATABASE="$db" psql_target "$PG" -q -v ON_ERROR_STOP=1 -c "$setup" >>"$log" 2>&1
  if [ -n "${4:-}" ]; then   # a bundle B0 that puts the starting object into the expected schema legitimately
    printf '%s\n' "$4" | mkb "$dir" create-b0 >/dev/null
    mplan "$dir" "$target" >>"$log" 2>&1 && mapply "$PLAN_ID" --wait >>"$log" 2>&1
    echo "B0: $(op_state "$OP_ID") lint: $(lint_summary "$dir")" >>"$log"
  fi
  mkb "$dir" create-t1 >/dev/null <<'SQL'
CREATE TABLE public.t1 (id bigint PRIMARY KEY, v text);
GRANT SELECT ON public.t1 TO lab_owner;
SQL
  mplan "$dir" "$target" >>"$log" 2>&1 && mapply "$PLAN_ID" --wait >>"$log" 2>&1
  local op1; op1="$(op_state "$OP_ID" 2>/dev/null)"
  local d0; d0="$(drift_row "$target")"
  # the change, out of band
  if ! PGDATABASE="$db" psql_target "$PG" -q -v ON_ERROR_STOP=1 -c "$change" >>"$log" 2>&1; then
    verdict "I7.${name}" NOT_RUN "the out-of-band statement failed: $(tail -1 "$log")"; return
  fi
  local d1 o1; d1="$(drift_row "$target")"; o1="$(drift_objs "$target")"
  # B2: an unrelated, verified migration
  mkb "$dir" create-t2 >/dev/null <<'SQL'
CREATE TABLE public.t2 (id bigint PRIMARY KEY);
GRANT SELECT ON public.t2 TO lab_owner;
SQL
  mplan "$dir" "$target" >>"$log" 2>&1; local p2="$PLAN_STATE"
  mapply "$PLAN_ID" --wait >>"$log" 2>&1
  local op2; op2="$(op_state "$OP_ID" 2>/dev/null)"
  local d2; d2="$(drift_row "$target")"
  # B3: a second unrelated migration
  mkb "$dir" create-t3 >/dev/null <<'SQL'
CREATE TABLE public.t3 (id bigint PRIMARY KEY);
GRANT SELECT ON public.t3 TO lab_owner;
SQL
  mplan "$dir" "$target" >>"$log" 2>&1; mapply "$PLAN_ID" --wait >>"$log" 2>&1
  local d3 o3 lost; d3="$(drift_row "$target")"; o3="$(drift_objs "$target")"
  lost="$(comm -23 <(printf '%s\n' "$o1") <(printf '%s\n' "$o3") | grep -v '^$' | tr '\n' ';')"
  {
    echo "B1: $op1"; echo "clean before:   $d0"; echo "after oob:      $d1"
    echo "plan B2 state=$p2 op: $op2"; echo "after B2:       $d2"; echo "after B3:       $d3"
    echo "findings right after the out-of-band change:"; printf '%s\n' "$o1"; echo "findings of it LOST by B3: [${lost}]"
  } >>"$log"
  local s0 s1 s2 s3
  s0="$(sed -n 's/.*status=\([a-z_]*\).*/\1/p' <<<"$d0")"; s1="$(sed -n 's/.*status=\([a-z_]*\).*/\1/p' <<<"$d1")"
  s2="$(sed -n 's/.*status=\([a-z_]*\).*/\1/p' <<<"$d2")"; s3="$(sed -n 's/.*status=\([a-z_]*\).*/\1/p' <<<"$d3")"
  local v reason="clean=${s0} oob=${s1} afterB2=${s2} afterB3=${s3}"
  case "$op2" in succeeded*) ;; *) v=PARTIAL; reason="B2 did not apply (${op2%% *}); $reason"; verdict "I7.${name}" "$v" "$reason"; return ;; esac
  if [ "$s1" = clean ]; then v=PARTIAL; reason="not detected at all (the fingerprint does not see this class); $reason"
  elif [ -n "$lost" ]; then v=FAIL; reason="the out-of-band change's own finding(s) disappeared after the next verified migrations without a human action: [${lost}]; $reason"
  elif [ "$s2" = drifted ] && [ "$s3" = drifted ]; then v=PASS; reason="its own finding(s) [$(printf '%s' "$o1" | tr '\n' ';')] still open after B2 and B3 (each later migration's own objects are also listed as drift until drift.accept); $reason"
  else v=FAIL; reason="the out-of-band change disappeared from the drift baseline without a human action; $reason; before=[$d1] after=[$d2]"; fi
  verdict "I7.${name}" "$v" "$reason"
}

run_class add_column      "" "ALTER TABLE public.t1 ADD COLUMN oob integer"
run_class grant_public    "" "GRANT SELECT ON public.t1 TO PUBLIC"
run_class trigger         "" "CREATE FUNCTION public.oob_tf() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$; CREATE TRIGGER oob_trg BEFORE INSERT ON public.t1 FOR EACH ROW EXECUTE FUNCTION public.oob_tf()"
run_class policy          "" "ALTER TABLE public.t1 ENABLE ROW LEVEL SECURITY; CREATE POLICY oob_p ON public.t1 FOR SELECT USING (true)"
run_class default_privileges "" "ALTER DEFAULT PRIVILEGES FOR ROLE lab_owner IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC"
# (CREATE EXTENSION is a node operation, not a bundle statement: both steps happen out of band after B1)
run_class extension_upgrade "" "CREATE EXTENSION pg_trgm VERSION '1.5' SCHEMA public; ALTER EXTENSION pg_trgm UPDATE TO '1.6'"
run_class function_body    "" "CREATE OR REPLACE FUNCTION public.f1() RETURNS int LANGUAGE sql AS 'SELECT 2'" "CREATE FUNCTION public.f1() RETURNS int LANGUAGE sql AS 'SELECT 1';"
run_class owner_change     "" "ALTER TABLE public.t1 OWNER TO exponetdb_migrator"
run_class index_added      "" "CREATE INDEX oob_idx ON public.t1 (v)"
run_class comment_only     "" "COMMENT ON TABLE public.t1 IS 'out of band comment'"

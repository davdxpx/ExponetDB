#!/usr/bin/env bash
# Case (iii) on PRODUCTION: restore into a Control Store older than the production ledger, then reconcile. Needs a production target whose
# ledger the Control Store already mirrors (the first RB-10 round showed that a never-mirrored production target is simply not blocked).
#   30-prod-cycle.sh prep      P2 staging -> production (approved), dump D2, then P3 staging -> production (approved) AFTER the dump
#   30-prod-cycle.sh destroy   remove the Control Store and its data (roles keep running), restore D2 (superuser restore_admin3), RB-10 checks
#   30-prod-cycle.sh reconcile production: status, plan, ledger reconcile, apply, approvals and step-ups counted
. /srv/work/s3-infra/s3/lib.sh
s3_release new
OFF=/srv/work/s3/offline; OUT="${S3_LOGS}/loss"; mkdir -p "$OUT"
ship() { # dir bundle-slug sql  -> staging apply, production plan, production apply + approval
  local dir="$1" slug="$2" id
  id="$(mkb "$dir" "$slug" <<<"$3")"
  mplan "$dir" lab/platform/staging >/dev/null && mapply "$PLAN_ID" --wait >/dev/null; echo "staging: $(op_state "$OP_ID")"
  (cd "$dir" && exdb_json migration plan --target lab/platform/production --stored "$id") >"$OUT/prod-plan-$slug.json"
  local pp; pp="$(jq -r '.data.id' "$OUT/prod-plan-$slug.json")"; echo "production plan $pp: decision=$(jq -r '.data.decision' "$OUT/prod-plan-$slug.json") approvals=$(jq -c '.data.approvals' "$OUT/prod-plan-$slug.json")"
  local op; op="$(exdb_json plan apply "$pp" --no-wait --yes | jq -r '.operationId // .data.operationId // .data.id')"; sleep 2
  echo "production op $op: $(op_state "$op")"; human approve "$op" 2>&1 | head -2
  local i; for i in $(seq 1 60); do s="$(op_state "$op")"; case "${s%% *}" in succeeded|failed|verification_failed|needs_attention) break;; esac; sleep 1; done
  echo "production op after approval: $(op_state "$op")"
}
case "${1:?prep|destroy|reconcile}" in
prep)
  d="$(new_project cycle)"
  ship "$d" cycle-p2 "CREATE TABLE public.cycle_p2 (id int PRIMARY KEY); GRANT SELECT ON public.cycle_p2 TO lab_owner;"
  echo "mirror rows for production: $(ctl_sql "select count(*) from migrations.ledger_mirror m join registry.targets t using (target_id) where t.path='lab/platform/production'"); live ledger rows: $(ledger pg17 lab_production | wc -l)"
  bash "${S3_DIR}/counts.sh" cycledump >/dev/null; cs_dump "${OFF}/control-dump2.sql.gz"; echo "last audit seq at dump 2: $(ctl_sql 'SELECT max(seq) FROM audit.audit_events')"
  d3="$(new_project cycle3)"
  ship "$d3" cycle-p3 "CREATE TABLE public.cycle_p3 (id int PRIMARY KEY); GRANT SELECT ON public.cycle_p3 TO lab_owner;"
  echo "after the dump: production ledger rows=$(ledger pg17 lab_production | wc -l), audit seq $(ctl_sql 'SELECT max(seq) FROM audit.audit_events')"
  ;;
destroy)
  T0=$(epoch_ms)
  docker rm -f "${EXSTACK_CONTROL_NAME}" >/dev/null && rm -rf "${EXSTACK_CONTROL_DATA}"; sleep 3
  control_container_start restore_admin3 && cs_restore "${OFF}/control-dump2.sql.gz" || exit 1
  echo "restored in $(( $(epoch_ms) - T0 )) ms; status: $(cs_status | jq -c '{status,expected,applied}')"
  for i in $(seq 1 90); do stack_ready && break; sleep 1; done; echo "serve ready after $i s; $(role_versions | awk '{printf "%s=%s ", $1,$2}')"
  ;;
reconcile)
  T=lab/platform/production; dir="$(new_project cycle-rec)"
  mkb "$dir" cycle-p4 <<<"CREATE TABLE public.cycle_p4 (id int PRIMARY KEY); GRANT SELECT ON public.cycle_p4 TO lab_owner;" >/dev/null
  echo "status: $(cd $dir && exdb_json migration status --target $T | jq -c .data.mirror)"
  echo "plan: $(cd $dir && exdb migration plan --target $T 2>&1 | head -2 | tr '\n' '|')"
  j="$(exdb_json migration ledger reconcile --target $T --note 'Control Store restored from dump 2; production applied cycle-p3 after it')"
  RP="$(jq -r '.data.id // empty' <<<"$j")"
  echo "reconcile plan ${RP:-none}: decision=$(jq -r '.data.decision // "-"' <<<"$j") class=$(jq -r '.data.class // "-"' <<<"$j") approvals=$(jq -c '.data.approvals' <<<"$j") requirements=$(jq -c '.data.requirements' <<<"$j" | cut -c1-300) error=$(jq -r '.error.code // "-"' <<<"$j")"
  jq -c '[.data.policyRules[]? | select(.result!="pass" and .result!="not_applicable") | {id,result,severity,message,overridableByBreakGlass}]' <<<"$j" | cut -c1-700
  [ -n "$RP" ] || exit 1
  echo "--- apply as the signed-in owner (CLI, --yes)"; ja="$(exdb_json plan apply "$RP" --no-wait --yes)"; echo "$ja" | jq -c '{status, error: .error, op: (.operationId // .data.operationId)}' | cut -c1-700
  OPR="$(jq -r '.operationId // .data.operationId // .data.id // empty' <<<"$ja")"
  if [ -n "$OPR" ]; then sleep 2; echo "op $OPR: $(op_state "$OPR")"; exdb operation show "$OPR" 2>&1 | sed -n 6,16p
    echo "--- approve (a person; the Web App's approval page)"; human approve "$OPR" 2>&1 | head -4
    for i in $(seq 1 40); do s="$(op_state "$OPR")"; case "${s%% *}" in succeeded|failed|needs_attention|canceled|awaiting_approval) [ "$i" -gt 3 ] && break;; esac; sleep 1; done
    echo "op after approval: $(op_state "$OPR")"; exdb operation show "$OPR" 2>&1 | sed -n 1,18p
  else echo "(apply refused before an operation existed)"; fi
  echo "status after: $(cd $dir && exdb_json migration status --target $T | jq -c .data.mirror)"
  ;;
esac

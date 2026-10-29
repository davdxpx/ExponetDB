#!/usr/bin/env bash
# After a restore into a Control Store older than the targets' ledgers (RB-10 step 6): the flow an operator needs on the NEW release.
# Per target: status -> plan (blocked?) -> `migration ledger reconcile` -> plan apply -> status -> a new change plans again. Counts every step.
# Usage: 70-reconcile.sh <target> [<target> ...]     (paths, e.g. lab/platform/staging)
. /srv/work/s3-infra/s3/lib.sh
s3_release new
STEPS=0; step() { STEPS=$((STEPS + 1)); printf '  step %d: %s\n' "$STEPS" "$*"; }
dir="$(new_project reconcile-probe)"
mkb "$dir" reconcile-probe-change <<'SQL' >/dev/null
CREATE TABLE public.reconcile_probe (id int PRIMARY KEY);
GRANT SELECT ON public.reconcile_probe TO lab_owner;
SQL
for T in "$@"; do
  echo "=== $T"; STEPS=0; t0=$(epoch_ms)
  step "migration status: $(cd "$dir" && exdb_json migration status --target "$T" | jq -c '{mirror: .data.mirror, applied: .data.applied // null}' | cut -c1-200)"
  j="$(cd "$dir" && exdb_json migration plan --target "$T")"; step "migration plan (a new change): error=$(jq -r '.error.code // "none"' <<<"$j") msg=$(jq -r '.error.message // ""' <<<"$j" | cut -c1-140)"
  echo "    text form: $(cd "$dir" && exdb migration plan --target "$T" 2>&1 | tr '\n' '|' | cut -c1-300)"
  j="$(exdb_json migration ledger reconcile --target "$T" --note "Control Store restored from the pre-upgrade dump; adopt the target's ledger")"
  RP="$(jq -r '.data.id // empty' <<<"$j")"
  step "migration ledger reconcile -> plan ${RP:-none}: decision=$(jq -r '.data.decision // "-"' <<<"$j") class=$(jq -r '.data.class // "-"' <<<"$j") approvals=$(jq -c '.data.approvals // null' <<<"$j") requirements=$(jq -c '.data.requirements // []' <<<"$j" | cut -c1-200) error=$(jq -r '.error.code // "none"' <<<"$j") $(jq -r '.error.message // ""' <<<"$j" | cut -c1-200)"
  echo "    plan content: $(jq -c '.data.change.content // .data.change // null' <<<"$j" | cut -c1-500)"
  if [ -n "$RP" ]; then
    ja="$(exdb_json plan apply "$RP" --yes)"; OPR="$(jq -r '.operationId // .data.operationId // .data.id // empty' <<<"$ja")"
    step "plan apply ${RP} -> op ${OPR:-none}: error=$(jq -r '.error.code // "none"' <<<"$ja") $(jq -r '.error.message // ""' <<<"$ja" | cut -c1-200) store: $( [ -n "$OPR" ] && op_state "$OPR" )"
  fi
  step "migration status after: $(cd "$dir" && exdb_json migration status --target "$T" | jq -c '{mirror: .data.mirror}' | cut -c1-200)"
  j="$(cd "$dir" && exdb_json migration plan --target "$T")"; step "migration plan again: state=$(jq -r '.data.state // "-"' <<<"$j") decision=$(jq -r '.data.decision // "-"' <<<"$j") error=$(jq -r '.error.code // "none"' <<<"$j")"
  echo "  => $STEPS steps, $(( $(epoch_ms) - t0 )) ms"; timing reconcile "$T" "$(( $(epoch_ms) - t0 ))" "steps=$STEPS"
done

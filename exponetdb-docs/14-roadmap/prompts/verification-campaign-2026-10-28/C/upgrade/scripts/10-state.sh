#!/usr/bin/env bash
# Realistic state on the OLD release (d0229550): a project with bundles applied and verified on PG16 (dev16) and PG17 (staging),
# an operation awaiting human approval (production), an operation parked in needs_attention (fresh PG16 target, verification cut),
# a plan that is created and never applied, a bundle that is stored and never applied, audit rows, the node (AGENT=1).
. /srv/work/s3-infra/s3/lib.sh
s3_release old
OUT="${S3_LOGS}/state"; mkdir -p "$OUT"
J() { cat >"$OUT/$1.json"; }
dir="$(new_project upg)"; echo "project dir $dir"

C1=$(mkb "$dir" accounts <<'SQL'
CREATE TABLE public.accounts (id int PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.accounts TO lab_owner;
SQL
)
C2=$(mkb "$dir" invoices <<'SQL'
CREATE TABLE public.invoices (id int PRIMARY KEY, account_id int NOT NULL REFERENCES public.accounts(id), total numeric(12,2) NOT NULL DEFAULT 0);
GRANT SELECT ON public.invoices TO lab_owner;
SQL
)
C3=$(mkb "$dir" invoices-account-index <<'SQL'
CREATE INDEX invoices_account_id_idx ON public.invoices (account_id);
SQL
)
# order is the DAG, not the file names: invoices depends on accounts, the index on invoices
for pair in "$C2:$C1" "$C3:$C2"; do m=${pair%%:*}; dep=${pair##*:}; f=$(ls -d "$dir"/migrations/${m}_*)/migration.yaml; sed -i "s/^dependsOn: \[\]/dependsOn: [$dep]/" "$f"; done
ls "$dir/migrations"

# 1. applied and verified on PG17 staging and PG16 dev16
for t in staging dev16; do
  mplan "$dir" "lab/platform/$t" && timed state "apply-$t" mapply "$PLAN_ID" --wait
  echo "$t: $(op_state "$OP_ID")"
done
echo "staging ledger:"; ledger pg17 lab_staging; echo "dev16 ledger:"; ledger pg16 lab_dev16

# 2. production: one bundle, evidence from staging, applied from the CLI: the apply waits for a human approval
dp="$(new_project upg-prod)"
PC="$(mkb "$dp" prod-change <<'SQL'
CREATE TABLE public.prod_change (id int PRIMARY KEY);
GRANT SELECT ON public.prod_change TO lab_owner;
SQL
)"
mplan "$dp" lab/platform/staging && mapply "$PLAN_ID" --wait
(cd "$dp" && exdb_json migration plan --target lab/platform/production --stored "$PC") >"$OUT/prod-plan.json"
PROD_PLAN="$(jq -r '.data.id' "$OUT/prod-plan.json")"
echo "production plan ${PROD_PLAN}: decision=$(jq -r '.data.decision' "$OUT/prod-plan.json") approvals=$(jq -c '.data.approvals' "$OUT/prod-plan.json")"
APPROVAL_OP="$(exdb_json plan apply "$PROD_PLAN" --no-wait --yes | jq -r '.operationId // .data.operationId // .data.id')"; sleep 3
echo "production op $APPROVAL_OP: $(op_state "$APPROVAL_OP")"
echo "$APPROVAL_OP" >"$OUT/op-awaiting-approval.id"; echo "$PROD_PLAN" >"$OUT/plan-awaiting-approval.id"

# 3. needs_attention on a fresh PG16 target: recipe of B/failure/I9-exits.sh (scenario rollback). The verification of a rollback reads
#    the fingerprint of a bloated catalog, which takes seconds: at `verifying` the path to the target is cut and its sessions are
#    terminated, the verification cannot finish. (An apply's own verification is only milliseconds wide: tried, missed.)
T="$(add_target s3na6 pg16)"; db="lab_s3na6"; echo "fresh target $T"
PGPORT16=$(_stk_port pg16)
cut_target() { net_block "$PGPORT16" reject; psql_target pg16 -Atc "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename LIKE 'exponetdb_%' AND pid <> pg_backend_pid()" >/dev/null 2>&1; }
bloat pg16 "$db" 1500
d2="$(new_project upg-na)"
NAID="$(DOWN_SQL='DROP TABLE public.na_demo;' mkb "$d2" na-demo <<'SQL'
CREATE TABLE public.na_demo (id int PRIMARY KEY);
GRANT SELECT ON public.na_demo TO lab_owner;
SQL
)"
mplan "$d2" "$T" && mapply "$PLAN_ID" --wait
(cd "$d2" && exdb_json migration rollback --target "$T" "$NAID") >"$OUT/na-rollback-plan.json"
RB_PLAN="$(jq -r '.data.id' "$OUT/na-rollback-plan.json")"; echo "rollback plan $RB_PLAN $(jq -r '.data.decision' "$OUT/na-rollback-plan.json")"
mapply "$RB_PLAN" --no-wait; NA_OP="$OP_ID"
inject_on_state "$NA_OP" verifying cut_target 120 || echo "injection window missed"
for i in $(seq 1 150); do s="$(op_state "$NA_OP")"; case "${s%% *}" in needs_attention|failed|succeeded|verification_failed) break;; esac; sleep 2; done
net_unblock
echo "na op $NA_OP: $(op_state "$NA_OP")"
echo "$NA_OP" >"$OUT/op-needs-attention.id"

# 4. a stored bundle that is never applied: ingested with a plan on dev18 that is left pending (expires 30 min after creation)
mkb "$dir" never-applied-widgets >/dev/null <<'SQL'
CREATE TABLE public.widgets (id int PRIMARY KEY, label text);
GRANT SELECT ON public.widgets TO lab_owner;
SQL
echo "ledger/plan for dev18 will be created by 25-pending-plan.sh (it must be fresh when the upgrade starts)"
cp -a "$dir" "$OUT/project-upg" 2>/dev/null

exdb_json node list | jq -c '.data.items[] | {id, state, version: (.agentVersion // .version // null)}' | tee "$OUT/node.json"
exdb_json operation list | jq -r '.data.items[] | [.id // .operationId, .state, .kind] | @tsv' | sort -k2 | awk -F'\t' '{c[$2]++} END{for(k in c) print "operations in state " k ": " c[k]}'

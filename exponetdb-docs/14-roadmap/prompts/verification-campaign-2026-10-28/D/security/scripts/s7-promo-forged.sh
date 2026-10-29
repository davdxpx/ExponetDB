#!/usr/bin/env bash
# S7 task 2c: FORGED EVIDENCE (F/findings-B1.md, second P2). Disposable lab only.
# On the staging (evidence) target, as the database superuser, write a ledger row for a bundle that was never applied there
# (a REAL operation id of that target, a matching checksum) and a passed verification row; then plan the bundle for production.
# Variant F : fingerprint_before NULL.  Variant F2: fingerprint_before copied from the real row (lineage would match).
# Variant F3: a real operation id of a DIFFERENT target (shows "any operation id" counts).
# usage on the server: source /srv/work/s7/env.sh; ./s7-promo-forged.sh <project dir> <evidence slug> <prod slug>
set -u
source /srv/work/s7/env.sh
P=${1:?project dir}; EVI=${2:-s7evi}; PRD=${3:-s7prd}; DB=lab_${EVI}
cd "$P" || exit 1
L7=${L7:-/srv/work/logs-s7}
row() { jq -c --arg id "$1" '{decision:.data.decision,state:.data.state,err:.error.code,evidence:[.data.change.analysis.evidence[]?|select(.migrationId==$id)|{status,lineage,verificationId:(.verificationId!=null)}],rules:[.data.policyRules[]?|select(.result!="pass")|{id,severity,result}]}' "$2"; }
plan_prod() { exdb_json migration plan --target "lab/platform/${PRD}" "$1" > "$2"; row "$1" "$2"; }
# a well-formed verification id (vfy_ + 26 Crockford characters): the first try used a malformed one and the plan was refused at apply (see promotion-leftovers.md)
vid() { python3 -c "import secrets;a='0123456789ABCDEFGHJKMNPQRSTVWXYZ';print('01M64W'+''.join(secrets.choice(a) for _ in range(20)))"; }
# the real row we copy from (the first genuine ledger row of the evidence target)
REAL_OP=$(PGDATABASE=$DB psql_target pg17 -Atc "select operation_id from exponetdb.schema_migrations order by applied_seq limit 1")
OTHER_OP=$(ctl_sql "select operation_id from operations.operations where kind='registry.environment.create' limit 1" 2>/dev/null)
echo "real op on evidence target: $REAL_OP ; a registry.environment.create operation (not a migration at all): ${OTHER_OP:-none}"
forge() { # id name checksum verifydigest op fpmode
  local id=$1 name=$2 sum=$3 vd=$4 op=$5 fp=$6 fpexpr="NULL"
  [ "$fp" = copy ] && fpexpr="(select fingerprint_before from exponetdb.schema_migrations order by applied_seq limit 1)"
  PGDATABASE=$DB psql_target pg17 -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO exponetdb.schema_migrations (migration_id, origin, name, checksum, checksum_provenance, source_digest, verify_digest, rollback_digest,
   manifest, dependencies, transactional, source, applied_at, apply_duration_ms, plan_id, operation_id, actor_ref, client_ref,
   engine_version, pg_version_num, fingerprint_before, fingerprint_after)
SELECT '$id', origin, '$name', '$sum', checksum_provenance, source_digest, '$vd', rollback_digest, manifest, '{}', transactional, source,
   now(), 5, plan_id, '$op', actor_ref, client_ref, engine_version, pg_version_num, $fpexpr, fingerprint_after
  FROM exponetdb.schema_migrations ORDER BY applied_seq LIMIT 1;
INSERT INTO exponetdb.migration_verifications (verification_id, migration_id, operation_id, verify_digest, started_at, finished_at, status, structural, runtime, engine, fingerprint)
SELECT 'vfy_$(vid)', '$id', '$op', '$vd', now(), now(), 'passed', structural, runtime, engine, fingerprint
  FROM exponetdb.migration_verifications ORDER BY started_at LIMIT 1;
SQL
}
pick() { awk -F'\t' -v re="$2" '$2 ~ re' "$1"; }
IFS=$'\t' read -r IDF _ SUMF VDF < <(pick "$L7/forge-checksums.tsv" '_s7-forged$')
IFS=$'\t' read -r IDG _ SUMG VDG < <(pick "$L7/forge-checksums.tsv" '_s7-forged2$')
echo "== 0. baseline (before forging): F planned for production"
plan_prod "$IDF" "$L7/forge-0.json"
echo "== 1. variant F (real op id of the evidence target, fingerprint_before NULL)"
forge "$IDF" s7-forged "$SUMF" "$VDF" "$REAL_OP" null && echo forged
plan_prod "$IDF" "$L7/forge-1.json"
echo "== 2. variant F2 (real op id of the evidence target, fingerprint_before copied from the genuine row)"
forge "$IDG" s7-forged2 "$SUMG" "$VDG" "$REAL_OP" copy && echo forged
plan_prod "$IDG" "$L7/forge-2.json"
echo "== 3. variant F3 (the id of a registry.environment.create operation, no migration, no target: the evidence reader only asks whether the id exists)"
if [ -n "${OTHER_OP:-}" ]; then
  mkb "$P" s7-forged3 >/dev/null <<<"CREATE TABLE public.s7_forged3(id int primary key); GRANT SELECT ON public.s7_forged3 TO lab_owner;"
  sed -i "/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:/dependsOn: []/}" "$P"/migrations/*s7-forged3/migration.yaml
  exdb_json migration checksum | jq -r '.data.items[]|[.migrationId,.directory,.checksum,.verifyDigest]|@tsv' > "$L7/forge-checksums3.tsv"
  IFS=$'\t' read -r IDH _ SUMH VDH < <(pick "$L7/forge-checksums3.tsv" '_s7-forged3$')
  forge "$IDH" s7-forged3 "$SUMH" "$VDH" "$OTHER_OP" copy && echo forged
  plan_prod "$IDH" "$L7/forge-3.json"
fi
if [ "${APPLY_PROD:-0}" = 1 ]; then
  echo "== 3b. apply the F2 plan to the disposable production target"
  exdb_json migration plan --target "lab/platform/${PRD}" "$IDG" > "$L7/forge-2b.json"; PL=$(jq -r '.data.id' "$L7/forge-2b.json")
  exdb_json plan apply "$PL" --wait > "$L7/forge-2-apply.json" 2>&1; jq -c '{err:.error.code,msg:.error.message,state:.data.state,op:(.operationId//.data.operationId)}' "$L7/forge-2-apply.json" | cut -c1-400
fi
echo "== 4. what the product says about the evidence target now (ledger vs mirror), if it looks"
exdb_json migration status --target "lab/platform/${EVI}" 2>&1 | jq -c '{err:.error.code, mirror:(.data.mirror // .data.ledger.mirror // null), applied:[.data.applied[]?.migrationId]|length, summary:(.data|keys)}' | cut -c1-400

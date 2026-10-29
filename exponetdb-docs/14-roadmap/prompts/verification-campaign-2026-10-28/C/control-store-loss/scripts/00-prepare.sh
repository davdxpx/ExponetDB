#!/usr/bin/env bash
# Task 2 setup on the NEW release (the stack of C/upgrade, upgraded): fresh state, the backup the runbook prescribes, the offline kit
# (only what the docs say is kept outside the Control Store), then writes AFTER the backup that the loss will throw away.
# Library: C/upgrade/scripts/{lib.sh,counts.sh,diff-census.sh} (copied to /srv/work/s3-infra/s3/ on vc-1).
. /srv/work/s3-infra/s3/lib.sh
s3_release new
OFF=/srv/work/s3/offline; install -d -m 0700 "$OFF"
OUT="${S3_LOGS}/loss"; mkdir -p "$OUT"
echo "== fresh state on the new release ($(now))"
dp="$(new_project loss-prod)"
PC="$(mkb "$dp" loss-prod-change <<'SQL'
CREATE TABLE public.loss_prod_change (id int PRIMARY KEY);
GRANT SELECT ON public.loss_prod_change TO lab_owner;
SQL
)"
mplan "$dp" lab/platform/staging && mapply "$PLAN_ID" --wait
(cd "$dp" && exdb_json migration plan --target lab/platform/production --stored "$PC") >"$OUT/prod-plan.json"
PROD_PLAN="$(jq -r '.data.id' "$OUT/prod-plan.json")"
AP_OP="$(exdb_json plan apply "$PROD_PLAN" --no-wait --yes | jq -r '.operationId // .data.operationId // .data.id')"; sleep 3
echo "awaiting approval: $AP_OP $(op_state "$AP_OP")"; echo "$AP_OP" >"$OUT/ap-op.id"
echo "== census and the backup (complete pg_dumpall, the owner's practice)"
bash "${S3_DIR}/counts.sh" lossdump
t0=$(epoch_ms); cs_dump "${OFF}/control-dump.sql.gz"; timing loss "pg_dumpall" "$(( $(epoch_ms) - t0 ))"
echo "last audit seq at the dump: $(ctl_sql 'SELECT max(seq) FROM audit.audit_events')" | tee "$OUT/dump-seq.txt"
echo "== the offline kit: only what the documents say lives outside the Control Store"
cp "${EXSTACK_STATE}/keyring.json" "$OFF/keyring.json"                # control-store-runbook.md section 3: "keep the keyring offline, separately from the dump"
cp "${EXSTACK_STATE}/control.cred" "$OFF/control.cred"                # section 3: "keep the role passwords (credentials file) ... offline"
cp "${EXSTACK_STATE}/pki-root-key.pem" "$OFF/pki-root-key.pem"        # secrets.md section 1: agent root CA private key is offline after bootstrap
rm -rf "$OFF/audit-export"; cp -a "${EXSTACK_ROOT}/audit-export" "$OFF/audit-export"   # the checkpoint bucket (RB-10 step 3)
chmod -R go-rwx "$OFF"; ls -la "$OFF" | awk '{print $1, $5, $9}'
echo "== writes AFTER the backup (the loss will throw these away)"
before_seq="$(ctl_sql 'SELECT max(seq) FROM audit.audit_events')"; before_ops="$(ctl_sql 'SELECT count(*) FROM operations.operations')"
human approve "$AP_OP" 2>&1 | head -3
for i in $(seq 1 60); do s="$(op_state "$AP_OP")"; case "${s%% *}" in succeeded|failed|verification_failed|needs_attention) break;; esac; sleep 1; done
echo "production op after approval: $(op_state "$AP_OP")"; echo "production ledger: $(ledger pg17 lab_production | wc -l) row(s)"
d2="$(new_project loss-after)"; mkb "$d2" loss-after-dump <<'SQL' >/dev/null
CREATE TABLE public.loss_after_dump (id int PRIMARY KEY);
GRANT SELECT ON public.loss_after_dump TO lab_owner;
SQL
for t in staging dev18; do mplan "$d2" "lab/platform/$t" >/dev/null && mapply "$PLAN_ID" --wait >/dev/null; echo "after-dump apply on $t: $(op_state "$OP_ID")"; done
after_seq="$(ctl_sql 'SELECT max(seq) FROM audit.audit_events')"; after_ops="$(ctl_sql 'SELECT count(*) FROM operations.operations')"
echo "written after the backup: audit ${before_seq} -> ${after_seq} ($((after_seq - before_seq)) events), operations ${before_ops} -> ${after_ops}; targets' ledgers: production=$(ledger pg17 lab_production | wc -l) staging=$(ledger pg17 lab_staging | wc -l) dev18=$(ledger pg18 lab_dev18 | wc -l)"
bash "${S3_DIR}/counts.sh" lossbefore lossdump >/dev/null; echo "$(now)" >"$OUT/prepared-at.txt"

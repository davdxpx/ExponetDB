#!/usr/bin/env bash
# Writes AFTER the dump and BEFORE the upgrade (the data an old-image rollback by restore loses): a bundle applied on two targets
# (their ledgers get rows the Control Store loses on restore), an operation, audit events. Records what was written.
. /srv/work/s3-infra/s3/lib.sh
s3_release old
OUT="${S3_LOGS}/state"; mkdir -p "$OUT"
before_audit="$(ctl_sql 'SELECT max(seq) FROM audit.audit_events')"; before_ops="$(ctl_sql 'SELECT count(*) FROM operations.operations')"
dir="$(new_project between)"
id="$(mkb "$dir" after-the-dump <<'SQL'
CREATE TABLE public.after_dump (id int PRIMARY KEY, note text);
GRANT SELECT ON public.after_dump TO lab_owner;
SQL
)"
for t in staging dev16; do mplan "$dir" "lab/platform/$t" >/dev/null && mapply "$PLAN_ID" --wait >/dev/null; echo "after-dump apply on $t: $(op_state "$OP_ID")"; done
echo "$id" >"$OUT/between-bundle.id"
after_audit="$(ctl_sql 'SELECT max(seq) FROM audit.audit_events')"; after_ops="$(ctl_sql 'SELECT count(*) FROM operations.operations')"
echo "written after the dump: audit seq ${before_audit} -> ${after_audit} ($((after_audit - before_audit)) events), operations ${before_ops} -> ${after_ops}, ledger rows on targets: staging=$(ledger pg17 lab_staging | wc -l) dev16=$(ledger pg16 lab_dev16 | wc -l)"
printf 'between\t%s\t%s\t%s\t%s\n' "$id" "$((after_audit - before_audit))" "$((after_ops - before_ops))" "$(now)" >>"${S3_LOGS}/between.tsv"

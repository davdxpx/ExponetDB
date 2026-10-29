#!/usr/bin/env bash
# The documented backup before an upgrade: a complete pg_dumpall of the Control Store (control-store-runbook.md section 3; the owner's
# practice on 2026-10-21: Coolify's scheduled dump_all, run by hand before the migration). Timed; the file is checked with gzip -t.
# The role-credentials file and the keyring stay in STATE (the runbook: offline, separately from the dump).
. /srv/work/s3-infra/s3/lib.sh
s3_release "${1:-old}"
LABEL="${2:-pre-upgrade}"
t0=$(epoch_ms); out="$(cs_dump "${EXSTACK_STATE}/dumps/control-${LABEL}.sql.gz")"; rc=$?; t1=$(epoch_ms)
timing backup "pg_dumpall ${LABEL}" "$((t1 - t0))" "rc=$rc $out"
echo "$out (rc=$rc, $((t1 - t0)) ms)"
gzip -t "${EXSTACK_STATE}/dumps/control-${LABEL}.sql.gz" && echo "gzip -t ok"
echo "$(now) dump ${LABEL} taken" >>"${S3_LOGS}/dump-times.log"
echo "dump content: $(gzip -dc "${EXSTACK_STATE}/dumps/control-${LABEL}.sql.gz" | wc -l) lines, roles: $(gzip -dc "${EXSTACK_STATE}/dumps/control-${LABEL}.sql.gz" | grep -c '^CREATE ROLE'), last audit seq in the store: $(ctl_sql 'SELECT max(seq) FROM audit.audit_events')"

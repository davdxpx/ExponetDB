#!/usr/bin/env bash
# A fresh plan that is created and never applied (plans live 30 minutes): run it right before the upgrade window. Needs the
# project dir of 10-state.sh. Prints the plan id; the id is kept in $S3_LOGS/state/plan-pending-*.id
. /srv/work/s3-infra/s3/lib.sh
s3_release "${1:-old}"
dir="${EXSTACK_PROJECTS}/upg"
mplan "$dir" lab/platform/dev18
echo "$PLAN_ID" >"${S3_LOGS}/state/plan-pending-$(date -u +%H%M%S).id"
echo "pending plan $PLAN_ID state=$PLAN_STATE at $(now)"

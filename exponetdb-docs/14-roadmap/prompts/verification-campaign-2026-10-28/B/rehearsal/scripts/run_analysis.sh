#!/usr/bin/env bash
# One import analysis with wall time and process memory: run_analysis.sh TARGET_SLUG SCRATCH_SLUG TAG   (hints: $PROJ/hints.json)
source /srv/work/s5/rehearsal/rh-lib.sh
cd "$PROJ"
T="${1:?target slug}"; S="${2:?scratch slug}"; TAG="${3:?tag}"
read -r SP_ WP_ GP_ <<<"$(cp_pids | tr '\n' ' ')"
memwatch "$L/mem-$TAG.log" "$SP_" "$WP_" "$GP_"
tm "analysis-$TAG" exdb migration import analyze --target "lab/platform/$T" --scratch "lab/platform/$S" --hints "$PROJ/hints.json" --apply ${EXTRA:-}
rc=$?
memstop
echo "RSS peak (MB) serve/worker/gateway:"; for i in 2 3 4; do awk -v c=$i '{split($c,a,"="); if (a[2]>m) m=a[2]} END{printf "  %s", m}' "$L/mem-$TAG.log"; done; echo
ctl_sql "select report_id, state, coalesce(incomplete_reason,'-'), drift_total, drift_truncated, analyzed_at-created_at from migrations.import_reports where target_id='$(target_id lab/platform/$T)' order by created_at desc limit 1"
exit $rc

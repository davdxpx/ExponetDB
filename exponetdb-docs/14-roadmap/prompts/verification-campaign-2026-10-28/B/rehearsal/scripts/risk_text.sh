#!/usr/bin/env bash
# The plan's risk text per bundle, flat: risk_text.sh PLAN_JSON   (the output of `exdb --json plan show`)
jq -r '.data.change.analysis.perMigration[] | "\(.migrationId[-6:]) lockSeverity=\(.lockSeverity) compat=\(.compatibility.declared)/\(.compatibility.observed) destructive=\(.destructive|length) rewriteRisk=\(.rewriteRisk|tojson)",
  (.statements[] | select(.lock != null or .rewrite != "none") | "    stmt \(.index) \(.kind) lock=\(.lock.mode // "-") on \(.lock.objects // [] | join(",")) severity=\(.lock.severity // "-") rewrite=\(.rewrite)"),
  (.lint[] | "    lint \(.level) \(.rule // ""): \(.message)")' "$1"

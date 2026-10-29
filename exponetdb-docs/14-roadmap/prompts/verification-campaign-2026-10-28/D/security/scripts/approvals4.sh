#!/usr/bin/env bash
# S4 task 2: approval spoofing, self-approval and replay on a PRODUCTION operation that waits for an approval and was applied by
# the owner's CLI client (usage: approvals4.sh <operation id> <plan id>). The stale-proof case runs 310 s in the background.
source /srv/work/s4/env.sh
cd $S4; refresh_creds
OP=$1; PL=$2
res() { jq -r '"\(.status) \(.code // .state // "")"' <<<"$1"; }
say() { printf '%-72s %s\n' "$1" "$2"; }
HASH=$(curl -s -H "Authorization: Bearer $(cat creds/owner.token)" http://127.0.0.1:58480/api/v1/plans/$PL | jq -r .planHash)
APPR="/api/v1/approvals/$OP/approve"
( R=$(rq owner ap-stale --age 310 POST $APPR "{\"planHash\":\"$HASH\",\"acknowledgeSelfApproval\":true}"); echo "$R" > $L4/api/ap-stale.line ) &
BG=$!
say "state before" "$(op_state $OP)"
say "P1 approve with a service-account API key" "$(bq service-account POST $APPR "{\"planHash\":\"$HASH\"}")"
say "P2 approve with the MCP client token" "$(bq mcp-client POST $APPR "{\"planHash\":\"$HASH\"}")"
say "P3 approve with the applying identity's own CLI bearer, acknowledged" "$(bq owner POST $APPR "{\"planHash\":\"$HASH\",\"acknowledgeSelfApproval\":true}")"
say "P4 approve with the admin's CLI bearer" "$(bq admin POST $APPR "{\"planHash\":\"$HASH\"}")"
say "P5 approve by viewer (web, fresh proof)" "$(res "$(rq viewer ap-p5 --reauth POST $APPR "{\"planHash\":\"$HASH\"}")")"
say "P6 approve by developer-nonprod (web, fresh proof)" "$(res "$(rq developer-nonprod ap-p6 --reauth POST $APPR "{\"planHash\":\"$HASH\"}")")"
say "P6b approve by developer-prod (web, fresh proof; holds no plans.approve)" "$(res "$(rq developer-prod ap-p6b --reauth POST $APPR "{\"planHash\":\"$HASH\"}")")"
say "P7 self-approval by the applying identity (web), no acknowledgement" "$(res "$(rq owner ap-p7 --reauth POST $APPR "{\"planHash\":\"$HASH\"}")")"
say "P9 admin (web, fresh proof), WRONG plan hash" "$(res "$(rq admin ap-p9 --reauth POST $APPR '{"planHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}')")"
say "P9b admin (web), body without planHash" "$(res "$(rq admin ap-p9b --reauth POST $APPR '{}')")"
say "state after the refusals" "$(op_state $OP)"
echo "waiting for the stale-proof case (310 s) ..."; wait $BG
say "P8 applying identity, acknowledged, proof 310 s old" "$(res "$(cat $L4/api/ap-stale.line)")"
say "state still" "$(op_state $OP)"
refresh_creds
say "P10 admin (a different person), fresh proof, right hash" "$(res "$(rq admin ap-p10 --reauth POST $APPR "{\"planHash\":\"$HASH\"}")")"
for i in $(seq 1 40); do s=$(op_state $OP); case "$s" in succeeded*|failed*|needs_attention*|verification_failed*) break;; esac; sleep 2; done
say "result after the admin's approval" "$(op_state $OP)"
say "P11 replay: approve the same operation again" "$(res "$(rq admin ap-p11 --reauth POST $APPR "{\"planHash\":\"$HASH\"}")")"
say "R1 replay: apply the consumed plan (owner bearer, no receipt)" "$(bq owner POST /api/v1/plans/$PL/apply '{}')"
say "R2 withdraw the consumed plan" "$(bq owner POST /api/v1/plans/$PL/withdraw '{}')"
ctl_sql "select count(*) from audit.audit_events where payload::text like '%$OP%'" | sed 's/^/audit events naming the operation: /'
ctl_sql "select action, count(*) from audit.audit_events where payload::text like '%$OP%' group by 1 order by 2 desc" | head -8

#!/usr/bin/env bash
# S4 task 2: CLI step-up receipt (ADR-0026) bypass attempts. The plans rb1..rb3 are three production plans of the owner's CLI client
# that need an approval and a re-authentication within 300 s (rule migration.nontransactional). The receipt travels in the header
# Exponetdb-Step-Up. Run in two steps because of the 130 s expiry wait; every step refreshes the tokens first.
source /srv/work/s4/env.sh
cd $S4
R1=$(cat rb1.plan); R2=$(cat rb2.plan); R3=$(cat rb3.plan)
res() { jq -r '"\(.status) \(.code // .state // "")"' <<<"$1"; }
say() { printf '%-72s %s\n' "$1" "$2"; }
A=http://127.0.0.1:58480/api/v1
ap() { # plan [header] [tokenfile]
  local tf=${3:-owner}; local out; out=$(curl -s -X POST -H "Authorization: Bearer $(cat creds/$tf.token)" -H 'content-type: application/json' ${2:+-H "Exponetdb-Step-Up: $2"} -d '{}' -w '\n%{http_code}' $A/plans/$1/apply)
  echo "$(echo "$out" | tail -1) $(echo "$out" | head -n -1 | jq -r '.code // .state // ""') $(echo "$out" | head -n -1 | jq -r '.id // ""' | cut -c1-14)"; }
mk() { curl -s -X POST -H "Authorization: Bearer $(cat creds/owner.token)" -H 'content-type: application/json' -d "{\"action\":\"plan.apply\",\"planId\":\"$1\"}" $A/step-ups; }
refresh_creds
say "T1 apply F1, CLI bearer, no receipt" "$(ap $R1)"
S2=$(mk $R2); S2ID=$(jq -r .id <<<"$S2"); C2=$(jq -r .userCode <<<"$S2"); say "T2a step-up requested for F2" "$(jq -r '"state=\(.state) planBound=\(.planHash!=null) codeShown=\(.userCode!=null)"' <<<"$S2")"
say "T2b apply F1 with the PENDING receipt of F2" "$(ap $R1 $S2ID)"
say "T2c admin (another person) confirms the owner's step-up" "$(res "$(rq admin su-t2c --reauth POST /api/v1/step-ups/$S2ID/confirm "{\"userCode\":\"$C2\"}")")"
say "T2d owner confirms with a WRONG user code" "$(res "$(rq owner su-t2d --reauth POST /api/v1/step-ups/$S2ID/confirm '{"userCode":"AAAA-AAAA"}')")"
say "T2e owner confirms F2's step-up (own, right code, fresh proof)" "$(res "$(rq owner su-t2e --reauth POST /api/v1/step-ups/$S2ID/confirm "{\"userCode\":\"$C2\"}")")"
say "T2f apply F1 with the CONFIRMED receipt bound to F2 (foreign plan)" "$(ap $R1 $S2ID)"
say "T2g service account presents the owner's confirmed receipt" "$(ap $R2 $S2ID service-account)"
say "T2h admin presents the owner's confirmed receipt on F2" "$(ap $R2 $S2ID admin)"
say "T3a SA requests a step-up for F1" "$(bq service-account POST /api/v1/step-ups "{\"action\":\"plan.apply\",\"planId\":\"$R1\"}")"
say "T3b MCP client requests a step-up for F1" "$(bq mcp-client POST /api/v1/step-ups "{\"action\":\"plan.apply\",\"planId\":\"$R1\"}")"
S3=$(mk $R3); S3ID=$(jq -r .id <<<"$S3"); C3=$(jq -r .userCode <<<"$S3")
say "T3c confirm F3's step-up now, then wait 130 s (receipt lives 120 s)" "$(res "$(rq owner su-t3c --reauth POST /api/v1/step-ups/$S3ID/confirm "{\"userCode\":\"$C3\"}")")"
sleep 130; refresh_creds
say "T3d apply F3 with the EXPIRED receipt" "$(ap $R3 $S3ID)"
S1=$(mk $R1); S1ID=$(jq -r .id <<<"$S1"); C1=$(jq -r .userCode <<<"$S1")
say "T4a confirm F1's step-up (own, fresh proof)" "$(res "$(rq owner su-t4a --reauth POST /api/v1/step-ups/$S1ID/confirm "{\"userCode\":\"$C1\"}")")"
say "T4b session (cookie) request carrying a step-up header" "$(res "$(rq owner su-t4b --reauth --header exponetdb-step-up=$S1ID POST /api/v1/plans/$R1/apply '{}')")"
say "T4c apply F1 with its own confirmed receipt" "$(ap $R1 $S1ID)"
OP=$(ctl_sql "select operation_id from operations.operations where plan_id='$R1'"); echo "$OP" > rb1.op
say "    operation of F1" "$([ -n "$OP" ] && op_state $OP)"
say "T5a replay: apply F2 with the redeemed receipt of F1" "$(ap $R2 $S1ID)"
say "T5b replay: apply F1 again with the same receipt" "$(ap $R1 $S1ID)"
say "T5c replay: apply F3 with the expired+foreign receipt again" "$(ap $R3 $S3ID)"
echo "operations for F1: $(ctl_sql "select count(*) from operations.operations where plan_id='$R1'")"
printf 'step-up rows by state: '; ctl_sql "select state||'='||count(*) from auth.step_ups group by state" 2>/dev/null | tr '\n' ' '; echo

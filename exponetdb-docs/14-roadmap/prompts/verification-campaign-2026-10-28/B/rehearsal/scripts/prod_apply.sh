#!/usr/bin/env bash
# Applies a production plan the way a team does: CLI apply (opens a step-up), the person confirms the step-up in the "browser",
# a second action approves the exact plan hash, then wait. usage: prod_apply.sh PLAN_ID TAG
source /srv/work/s5/rehearsal/rh-lib.sh
PL="${1:?plan}"; TAG="${2:?tag}"; cd "$PROJ"
S0=$(date +%s.%N)
( nohup bash -c "source /srv/work/s5/rehearsal/rh-lib.sh; cd $PROJ; exdb plan apply $PL --yes --no-wait" > "$L/prodapply-$TAG.log" 2>&1 < /dev/null & )
for i in $(seq 1 40); do grep -q "Code:" "$L/prodapply-$TAG.log" && break; sleep 0.5; done
STU=$(grep -o 'stu_[A-Z0-9]*' "$L/prodapply-$TAG.log" | head -1); CODE=$(awk '/^Code:/{print $2}' "$L/prodapply-$TAG.log")
echo "step-up $STU"
if [ -n "$STU" ]; then human stepup "$STU" "$CODE" | cut -c1-120; fi
for i in $(seq 1 60); do grep -q "Approve at\|Succeeded\|Error\|denied\|failed" "$L/prodapply-$TAG.log" && break; sleep 0.5; done
OP=$(grep -o 'op_[A-Z0-9]*' "$L/prodapply-$TAG.log" | head -1)
echo "operation $OP"; tail -12 "$L/prodapply-$TAG.log" | cut -c1-200
if [ -n "$OP" ] && grep -q "Approve at" "$L/prodapply-$TAG.log"; then human approve "$OP"; fi
[ -n "$OP" ] && wait_op "$OP" 900
S1=$(date +%s.%N); printf 'prod-apply-%s\t%s\t%s\t%.1f\t0\n' "$TAG" "$(date -u +%FT%TZ)" "$(date -u +%FT%TZ)" "$(echo "$S1 - $S0" | bc)" >> "$TIMINGS"
echo "prod apply wall: $(echo "$S1 - $S0" | bc) s"

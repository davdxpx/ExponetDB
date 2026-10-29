#!/usr/bin/env bash
# Helpers of the dress rehearsal (tester S5). Source after /etc/exstack.env is in place:  source rh-lib.sh
# shellcheck disable=SC1091,SC2034
source /srv/work/s5kit/stack-env.sh
RH=/srv/work/s5/rehearsal; L=/srv/work/logs-s5; TIMINGS=$L/timings.tsv; PROJ=/srv/work/s5/projects/rehearsal
mkdir -p "$L"
# tm NAME cmd...   run a step, keep its output in $L/NAME.log, append a row to timings.tsv (name, start, end, seconds, rc), print the tail
tm() {
  local name="$1"; shift; local s e t0 rc
  t0=$(date -u +%FT%TZ); s=$(date +%s.%N)
  "$@" >"$L/$name.log" 2>&1; rc=$?
  e=$(date +%s.%N)
  printf '%s\t%s\t%s\t%.1f\t%s\n' "$name" "$t0" "$(date -u +%FT%TZ)" "$(echo "$e - $s" | bc)" "$rc" >>"$TIMINGS"
  tail -"${TAIL:-12}" "$L/$name.log"; echo "[$name rc=$rc $(echo "$e - $s" | bc | cut -c1-6) s]"
  return $rc
}
# memwatch FILE PID...   sample RSS (MB) of the processes every second until the file STOP.memwatch appears
memwatch() {
  local out="$1"; shift; rm -f "$L/STOP.memwatch"
  ( while [ ! -e "$L/STOP.memwatch" ]; do
      printf '%s' "$(date -u +%T)"; for p in "$@"; do printf ' %s=%s' "$p" "$(awk '/VmRSS/{print int($2/1024)}' /proc/"$p"/status 2>/dev/null)"; done; echo
      sleep 1
    done >"$out" ) &
}
memstop() { touch "$L/STOP.memwatch"; sleep 1.5; rm -f "$L/STOP.memwatch"; }
cp_pids() { for r in serve worker gateway; do systemctl show -p MainPID --value "${EXSTACK_UNIT_PREFIX}-$r.service"; done; }
# wait_op OPERATION_ID [timeout s]  poll the Control Store until the operation is terminal
wait_op() {
  local id="$1" t="${2:-1800}" i st
  for i in $(seq 1 "$t"); do st=$(ctl_sql "SELECT state FROM operations.operations WHERE operation_id='$id'"); case "$st" in succeeded|failed|canceled|verification_failed|needs_attention|expired|denied) break ;; esac; sleep 1; done
  op_state "$id"
}
# happly PLAN_ID [--approve]  apply as the human owner; prints the operation id and sets HOP
happly() { local out; out=$(human apply "$@"); echo "$out"; HOP=$(jq -r 'select(.operationId) | .operationId' <<<"$out" | head -1); }

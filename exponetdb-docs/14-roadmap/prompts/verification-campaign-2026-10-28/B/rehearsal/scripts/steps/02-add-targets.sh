set -uo pipefail
source /srv/work/s5kit/stack-env.sh
t0=$(date +%s)
add_target rhstg pg17 nonprod 2>&1 | tail -2
add_target rhscr pg17 nonprod 2>&1 | tail -2
EXSTACK_EVIDENCE_FROM=rhstg add_target rhprod pg17 prod 2>&1 | tail -2
echo "targets added in $(( $(date +%s) - t0 )) s"
for db in lab_rhstg lab_rhscr lab_rhprod; do
  psql_target pg17 -d $db -X -q -f /srv/work/s5/rehearsal/legacy/prereq_db.sql
done
exdb target list 2>&1 | head -20
PID=$(stack_id project); echo project=$PID

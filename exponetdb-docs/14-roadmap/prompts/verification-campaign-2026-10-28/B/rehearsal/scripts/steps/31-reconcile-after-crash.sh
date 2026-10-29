source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
E2=$(cat $L/e2.id)
exdb migration status --target lab/platform/rhstg 2>&1 | sed -n 3,7p
TAIL=5 tm rs1-plan-e2 exdb migration plan $E2 --target lab/platform/rhstg
TAIL=26 tm rs1-reconcile-plan exdb migration ledger reconcile --target lab/platform/rhstg --note "Primary lost at 21:28:31 UTC; restored from base backup and WAL archive into a new instance, 12 s of commits lost, including bundle add-calendar-items-flag"
PL=$(grep -o "pln_[A-Z0-9]*" $L/rs1-reconcile-plan.log | head -1)
TAIL=3 tm rs1-reconcile-apply exdb plan apply $PL --wait
TAIL=4 tm rs1-plan-e2b exdb migration plan $E2 --target lab/platform/rhstg
PL2=$(grep -o "pln_[A-Z0-9]*" $L/rs1-plan-e2b.log | head -1)
TAIL=4 tm rs1-apply-e2 exdb plan apply $PL2 --wait
exdb migration status --target lab/platform/rhstg 2>&1 | sed -n 3,7p

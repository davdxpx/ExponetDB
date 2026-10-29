source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
R0=$(date +%s.%N)
TAIL=30 tm reconcile-plan exdb migration ledger reconcile --target lab/platform/rhstg --note "Point-in-time restore of the PG17 cluster to 21:08:17 UTC (before bundle create-region-settings); the target ledger is older than the mirror"
PL=$(grep -o "pln_[A-Z0-9]*" $L/reconcile-plan.log | head -1); echo plan=$PL
TAIL=25 tm reconcile-apply exdb plan apply $PL --wait
R1=$(date +%s.%N); echo "reconcile total (plan+apply): $(echo "$R1 - $R0" | bc) s"

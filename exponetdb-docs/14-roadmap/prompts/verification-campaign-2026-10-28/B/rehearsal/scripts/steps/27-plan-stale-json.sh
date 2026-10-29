source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
P2=$(grep -o "pln_[A-Z0-9]*" $L/swap2-plan.log | head -1)
exdb --json plan apply $P2 --wait 2>&1 | head -30 | cut -c1-300
echo "=== plan show (bindings)"
exdb_json plan show $P2 | jq -c '.data | {state, decision}' 

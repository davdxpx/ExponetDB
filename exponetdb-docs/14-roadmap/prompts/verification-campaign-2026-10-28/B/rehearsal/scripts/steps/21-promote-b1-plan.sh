source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
B1=$(grep ^B1 $L/bundle-ids-first.env | cut -d= -f2)
echo "=== promote B1 ($B1) to production"
TAIL=30 tm plan-prod-b1 exdb migration plan $B1 --target lab/platform/rhprod
PL=$(grep -o "pln_[A-Z0-9]*" $L/plan-prod-b1.log | head -1); echo $PL > $L/plan-id-prod-b1

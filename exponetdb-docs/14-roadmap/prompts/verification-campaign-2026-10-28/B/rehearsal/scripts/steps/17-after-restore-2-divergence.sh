source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
head -12 $L/migration-status-after-restore.log | cut -c1-200
exdb_json migration status --target lab/platform/rhstg > $L/mstatus-restored.json; jq -c '.data | del(.items,.migrations,.applied,.pending)' $L/mstatus-restored.json | cut -c1-600
echo "=== plan B7 again"
TAIL=12 tm plan-b7-after-restore exdb migration plan --target lab/platform/rhstg 01M64QV9RY834WB26XS7ZKJ3NQ
echo "=== drift check"
TAIL=6 tm drift-after-restore exdb drift check lab/platform/rhstg

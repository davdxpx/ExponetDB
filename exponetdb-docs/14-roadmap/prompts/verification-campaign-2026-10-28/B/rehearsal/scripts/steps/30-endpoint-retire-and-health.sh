source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
CL=$(stack_id cluster_pg17)
tm rs1-endpoint-retire-plan exdb cluster endpoint retire $CL end_01M64NH3179ZPZHNGD4RS6SST6 --reason primary_lost_restored_on_55517
PL=$(grep -o "pln_[A-Z0-9]*" $L/rs1-endpoint-retire-plan.log | head -1)
/srv/work/s5/rehearsal/prod_apply.sh $PL rs1-retire 2>&1 | tail -5 | cut -c1-200
sleep 10
TAIL=12 tm rs1-target-show3 exdb target show lab/platform/rhstg
TAIL=14 tm rs1-status exdb migration status --target lab/platform/rhstg
exdb health lab/platform/rhstg 2>&1 | head -20 | cut -c1-200

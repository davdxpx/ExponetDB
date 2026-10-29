source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
CL=$(stack_id cluster_pg17)
tm rs1-endpoint-plan exdb cluster endpoint add $CL --label rs1 --kind private --host 127.0.0.1 --port 55517 --tls-server-name pg17.exdb.test
PL=$(grep -o "pln_[A-Z0-9]*" $L/rs1-endpoint-plan.log | head -1)
/srv/work/s5/rehearsal/prod_apply.sh $PL rs1-endpoint 2>&1 | tail -14 | cut -c1-200
sleep 8
echo "endpoints now:"; exdb_json cluster endpoints $CL | jq -r '.data.items[] | "  \(.id) \(.label) \(.host):\(.port) \(.state)"'
TAIL=12 tm rs1-target-show2 exdb target show lab/platform/rhstg

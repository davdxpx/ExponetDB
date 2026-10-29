source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
CL=$(stack_id cluster_pg17)
exdb target list 2>&1 | sed -n 4,16p | cut -c1-120
exdb_json cluster endpoints $CL | jq -r '.data.items[] | "  \(.id) \(.label) \(.host):\(.port) \(.state)"'
echo "--- health detail rhstg"; exdb health lab/platform/rhstg 2>&1 | sed -n 5,30p | cut -c1-200
exdb_json health lab/platform/rhstg | jq -c '.data.conditions' | cut -c1-700
echo "--- plan against a suspended target"; TAIL=4 tm lg-plan-suspended exdb migration plan --target lab/platform/rhprod 2>&1 | cut -c1-200

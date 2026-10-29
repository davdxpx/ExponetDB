source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
CL=$(stack_id cluster_pg17)
tm lg-retire-plan exdb cluster endpoint retire $CL end_01M64SEMQDF73XT45G72R23GVS --reason wrong_instance_logical_copy >/dev/null
/srv/work/s5/rehearsal/prod_apply.sh $(grep -o 'pln_[A-Z0-9]*' $L/lg-retire-plan.log | head -1) lg-retire 2>&1 | tail -2 | cut -c1-200
sleep 8
echo "--- targets after the endpoint is gone"; exdb target list 2>&1 | grep -E "rhprod|rhrep|rhstg" | cut -c1-110
echo "--- resume"
for t in rhrep rhprod; do
  TAIL=6 tm lg-resume-$t exdb target resume lab/platform/$t 2>&1 | cut -c1-200
done

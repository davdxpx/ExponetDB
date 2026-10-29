source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
echo "bundles in the project:"; exdb migration graph 2>&1 | sed -n 1,20p
TAIL=40 tm plan-prod-all exdb migration plan --target lab/platform/rhprod

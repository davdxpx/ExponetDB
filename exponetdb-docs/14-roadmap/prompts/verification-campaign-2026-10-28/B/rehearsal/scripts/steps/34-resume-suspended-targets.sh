source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
exdb target resume --help 2>&1 | sed -n 1,14p | cut -c1-160
for t in rhrep rhprod; do
  TAIL=14 tm lg-resume-$t exdb target resume lab/platform/$t --reason endpoint_replaced_identity_verified --apply 2>&1 | cut -c1-200
done
exdb target list 2>&1 | grep -E "rhprod|rhrep" | cut -c1-110

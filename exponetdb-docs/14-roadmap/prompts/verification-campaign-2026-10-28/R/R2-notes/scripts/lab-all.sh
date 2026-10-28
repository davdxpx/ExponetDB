export PATH=$PATH:/usr/local/go/bin:/usr/local/bin
. /srv/work/r2/ftlib.sh
echo "################ LAB: TC-043 and TC-046"
bash /srv/work/r2/scripts/lab-bk-run.sh 2>&1 | tail -80
echo "################ LAB: TC-045"
bash /srv/work/r2/scripts/lab-t045.sh 2>&1 | tail -40
echo LAB-ALL-DONE

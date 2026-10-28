bash /srv/work/r2/scripts/pglab2.sh
bash /srv/work/r2/scripts/teardown.sh
bash /srv/work/r2/scripts/lab-bk-setup.sh > /srv/work/r2/logs/lab-bk-setup3.out 2>&1; tail -2 /srv/work/r2/logs/lab-bk-setup3.out
bash /srv/work/r2/scripts/lab-bk-run.sh 2>&1 | tail -90
echo "################ LAB: TC-045"
bash /srv/work/r2/scripts/lab-t045.sh 2>&1 | tail -45
echo CHAIN3-DONE

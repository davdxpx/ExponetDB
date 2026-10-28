bash /srv/work/r2/scripts/lab-bk-setup.sh > /srv/work/r2/logs/lab-bk-setup2.out 2>&1; tail -2 /srv/work/r2/logs/lab-bk-setup2.out
bash /srv/work/r2/scripts/lab-bk-run.sh 2>&1 | tail -90
echo "################ LAB: TC-045 (again, /var/lib/c35 owned by postgres)"
bash /srv/work/r2/scripts/lab-t045.sh 2>&1 | tail -45
echo CHAIN2-DONE

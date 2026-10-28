export PATH=$PATH:/usr/local/go/bin:/usr/local/bin
bash /srv/work/r2/scripts/teardown.sh
bash /srv/work/r2/scripts/lab-bk-setup.sh > /srv/work/r2/logs/lab-bk-setup4.out 2>&1; tail -1 /srv/work/r2/logs/lab-bk-setup4.out
cd /root/lab && bash t1_full.sh > /srv/work/r2/logs/t1b.raw 2>&1; tail -1 /root/lab/logs/last-full-run
echo "################ LAB: TC-046 with a 120 MB filesystem (the restore needs about 200 MB)"
bash /root/lab/lab-t046.sh 2>&1 | tail -25
echo CHAIN4-DONE

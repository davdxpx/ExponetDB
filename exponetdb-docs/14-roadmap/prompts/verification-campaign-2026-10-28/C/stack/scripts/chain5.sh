cd /srv/work/s6-infra/s6
bash kt-lease.sh >/dev/null 2>&1 </dev/null
bash kx2.sh >/dev/null 2>&1 </dev/null
bash obs-read.sh >/dev/null 2>&1 </dev/null
echo "chain5 finished" >>/srv/work/logs-s6/chain5.log

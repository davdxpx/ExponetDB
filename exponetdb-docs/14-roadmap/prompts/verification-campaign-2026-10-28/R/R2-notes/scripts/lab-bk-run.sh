export PATH=$PATH:/usr/local/go/bin:/usr/local/bin
cd /root/lab
echo "##### t1 (full backup, mode owned)"; bash t1_full.sh > /srv/work/r2/logs/t1.raw 2>&1; tail -5 /root/lab/logs/t1-full.log | cut -c1-300
echo "##### TC-043 t7c: restore to the end of the archive after a WAL segment was corrupted"; bash t7c.sh > /srv/work/r2/logs/t7c.raw 2>&1; sed -n 1,40p /root/lab/logs/t7c-corrupt-latest.log | cut -c1-400
echo "##### TC-046 t11: restore.execute with too little space"; bash t11_space_wrongkey.sh > /srv/work/r2/logs/t11.raw 2>&1; sed -n 1,16p /root/lab/logs/t11-space-wrongkey.log | cut -c1-500
echo LAB-BK-RUN-DONE

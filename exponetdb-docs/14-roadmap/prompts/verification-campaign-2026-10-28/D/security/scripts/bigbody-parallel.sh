source /srv/work/s4/env.sh; cd $S4
refresh_creds
PID=$(systemctl show -p MainPID --value exstack-serve.service)
( while :; do echo "$(grep VmRSS /proc/$PID/status | awk '{print $2/1024}') $(free -m | awk '/Mem:/{print $7}')"; sleep 0.1; done ) > $L4/par-rss.txt &
SP_=$!
for i in 1 2 3 4 5 6 7 8; do python3 bigbody.py creds/viewer.token 28 > $L4/par-$i.txt 2>&1 & done
wait $(jobs -p | grep -v $SP_) 2>/dev/null
sleep 3; kill $SP_
cat $L4/par-*.txt | python3 -c "
import sys,json
for l in sys.stdin:
    try: j=json.loads(l); print(j['status'],j['code'],j['latencySec'],'s')
    except Exception: print('ERR',l[:80])"
sort -n $L4/par-rss.txt | tail -1 | awk '{print "peak serve RSS MiB:",$1}'; sort -k2 -n $L4/par-rss.txt | head -1 | awk '{print "min MemAvailable MiB:",$2}'
curl -s -o /dev/null -w 'serve ready after: %{http_code}\n' http://127.0.0.1:58481/healthz/ready

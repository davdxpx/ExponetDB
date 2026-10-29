. /srv/work/s6-infra/s6.env
cd /srv/work/s6-infra
. ./stack-env.sh
ps -eo pid,args | grep -E "[k]x2.sh|[o]bs-read.sh|[c]hain5" | head
cp /srv/work/s6/state/cli/profiles.json /dev/null 2>&1
./stack-down.sh --purge 2>&1 | tail -12
rm -rf /etc/systemd/system/exs6-*.service.d; systemctl daemon-reload
docker rm -f s6-s3 exs6-control 2>&1 | head -2
docker volume ls -q | head; 
for l in $(losetup -a | cut -d: -f1); do losetup -d $l; done; losetup -a | wc -l
rm -f /dev/shm/s6* /srv/work/logs-s6/*.s6orig /srv/work/s6/ft-* 2>/dev/null
iptables -S | grep -c EXSTACK; tc qdisc show dev lo | head -1
echo "--- leftovers:"
docker ps -a --format '{{.Names}}'; systemctl list-units --all --no-pager | grep -E "exs6|exponetdb" | head; pg_lsclusters | tail -4; ss -ltn | grep -E ":5(84|64)[0-9]{2}" | head; ls /srv/work; df -h /srv | tail -1

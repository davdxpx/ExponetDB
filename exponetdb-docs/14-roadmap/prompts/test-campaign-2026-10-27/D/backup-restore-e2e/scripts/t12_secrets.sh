source /root/lab/lib.sh
exec > >(tee $LOGS/t12-secrets-leaks.log) 2>&1
P=/root/lab/cipher.pass; RPW=$(cat /var/lib/c35/restic.pw 2>/dev/null || echo NONE)
echo "=== files containing the pgBackRest passphrase (names only)"
grep -rlF -f $P /var/log /var/lib/exponetdb-node-engine /var/lib/exponetdb-node /var/lib/c35 /etc/exponetdb-node /etc/postgresql /etc/systemd /run/systemd 2>/dev/null | head -20
echo "=== journal (all boots) containing the passphrase: $(journalctl --no-pager -o cat 2>/dev/null | grep -cF -f $P) lines; restic password: $(journalctl --no-pager -o cat 2>/dev/null | grep -cF "$RPW")"
echo "=== unit files / properties containing it: $(systemctl show 'exponetdb-run-*' 2>/dev/null | grep -cF -f $P)"
echo "=== pgbackrest logs with cipher-pass lines:"; grep -h "cipher-pass" /var/log/pgbackrest/*.log | sed 's/cipher-pass=[^ ]*/cipher-pass=<seen>/' | sort | uniq -c | sort -rn | head -3 | cut -c1-200
echo "=== results/records of runs containing 'cipher' text: $(grep -rl cipher-pass /var/lib/exponetdb-node-engine/runs 2>/dev/null | wc -l) files; with the literal passphrase: $(grep -rlF -f $P /var/lib/exponetdb-node-engine/runs 2>/dev/null | wc -l)"
echo "=== process list snapshot now (any process with the passphrase in argv/env?)"
for p in /proc/[0-9]*; do tr '\0' ' ' < $p/cmdline 2>/dev/null | grep -qF -f $P && echo "argv: $(basename $p)"; done | head -3
echo "=== runbook-run: PGBACKREST_REPO1_CIPHER_PASS in the restored postmaster environment (expected by design):"; for pid in $(pgrep -f "postgres -D /var/lib/c35" 2>/dev/null); do tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | grep -c PGBACKREST_REPO1_CIPHER_PASS; done | head -2
echo "=== file modes: engine dir, run dirs (sample), repositories, config"
stat -c '%U:%G %a %n' /var/lib/exponetdb-node-engine /var/lib/exponetdb-node-engine/runs /var/lib/exponetdb-node-engine/scratch /var/lib/exponetdb-node-engine/reads /etc/exponetdb-node /etc/exponetdb-node/repositories /etc/exponetdb-node/repositories/* /etc/exponetdb-node/helper-trust.json /etc/pgbackrest/pgbackrest.conf
echo "run dirs with modes other than root:postgres 750: $(find /var/lib/exponetdb-node-engine/runs -mindepth 1 -maxdepth 1 -type d ! -perm 750 | wc -l); files other than 640/600: $(find /var/lib/exponetdb-node-engine/runs -mindepth 2 -maxdepth 2 -type f ! -perm 640 ! -perm 600 | wc -l); world-readable: $(find /var/lib/exponetdb-node-engine -perm -o+r ! -type l | grep -vc '^/var/lib/exponetdb-node-engine$' )"
find /var/lib/exponetdb-node-engine/runs -mindepth 2 -maxdepth 2 -type f \( -name record.json -o -name result.json -o -name cancel.json \) -printf '%u:%g %m %f\n' | sort | uniq -c
echo "=== leaks: units, ports, processes"
systemctl list-units 'exponetdb-run-*' --all --no-legend; systemctl list-units 'exdb-host-*' --all --no-legend
ss -ltnp | grep -E ':554[0-9][0-9]' | awk '{print $4, $6}'
pgrep -fa "postgres -D /var/lib/exponetdb-node-engine/scratch" || echo "no scratch postmaster"
pgrep -fa "pgbackrest|restic|engine-run" || echo "no engine process"
echo "scratch dirs left: $(ls /var/lib/exponetdb-node-engine/scratch | wc -l); run records: $(ls /var/lib/exponetdb-node-engine/runs | wc -l); df: $(df -h / | tail -1 | awk '{print $3" used of "$2}')"

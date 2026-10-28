# R1: TC-012 logical backup to a local (posix) restic repository through the shipped, sandboxed helper
source /root/lab/lib.sh
exec > >(tee $LOGS/${TAG:-new}-t12r1.log) 2>&1
mkdir -p /var/lib/c35; chown postgres: /var/lib/c35
RD=/etc/exponetdb-node/repositories/$RESTIC; RR=/var/lib/restic-repo
rm -rf $RR $RD; install -d -m0700 -o postgres -g postgres $RR; install -d -m0755 $RD
RPW=$(openssl rand -hex 16); printf '%s' "$RPW" > $RD/password; chmod 0600 $RD/password; echo "$RR" > $RD/repository; echo owned > $RD/mode; chmod 0644 $RD/mode $RD/repository
install -m0600 -o postgres -g postgres $RD/password /var/lib/c35/restic.pw
runuser -u postgres -- restic init --no-cache --repo $RR --password-file /var/lib/c35/restic.pw | tail -1
psqlx "CREATE ROLE appowner NOLOGIN; CREATE ROLE reader LOGIN; GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader" >/dev/null 2>&1 || true
ROWS=$(psqlx "SELECT count(*) FROM accounts"); echo "source accounts=$ROWS"
R=$(rid); T0=$(ts); c backup.run "{\"cluster\":$CLUSTER,\"repository\":$RESTICJ,\"runId\":\"$R\",\"kind\":\"logical\",\"databases\":[\"app\"]}" | jq -c '.error // .result|{runId}'
echo "-- unit while running:"; systemctl show exponetdb-run-$R.service -p ActiveState,ProtectSystem,ReadWritePaths 2>&1 | tr '\n' ' '; echo
out=$(wait_run $R ${MAXWAIT:-400}); echo "logical: state=$(echo "$out"|jq -r .result.state) label=$(echo "$out"|jq -r .result.outcome.label) duration=$(echo "$(ts) - $T0"|bc)s"
SNAP=$(echo "$out"|jq -r .result.outcome.label); echo "$out" | jq -r .result.excerpt | tail -4 | cut -c1-200
echo "-- backup.list restic"; c backup.list "{\"cluster\":$CLUSTER,\"repository\":$RESTICJ}" | jq -c '.result|{engineVersion,stanza,backups:[.backups[]|{label:.label[0:12],kind,sizeBytes}]}'
R2=$(rid); c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$RESTICJ,\"runId\":\"$R2\",\"label\":null,\"snapshot\":null}" >/dev/null; wait_run $R2 ${MAXWAIT:-400} | jq -c '.result|{state,verifyErrors:.outcome.verifyErrors}'
echo "-- restic check by hand: $(runuser -u postgres -- restic check --no-cache --repo $RR --password-file /var/lib/c35/restic.pw 2>&1 | tail -1)"
echo "-- snapshots by hand: $(runuser -u postgres -- restic snapshots --no-cache --repo $RR --password-file /var/lib/c35/restic.pw 2>&1 | tail -3 | tr '\n' '|')"

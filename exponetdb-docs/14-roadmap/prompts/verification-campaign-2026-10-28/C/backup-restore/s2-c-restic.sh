# Phase C1: logical backups (pg_dump -Fc + globals) through the shipped helper into a local restic repository and into S3 (versitygw over TLS)
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/c-restic.log) 2>&1
RESTICS3=bkr_01M70000000000000000000003
RESTICSJ='{"repositoryId":"'$RESTICS3'","engine":"restic","stanza":null,"repoIndex":null}'
SEC=/srv/work/s2/secrets
RR=/var/lib/restic-repo
mkdir -p /var/lib/c35; chown postgres: /var/lib/c35
install -m0600 -o postgres -g postgres $SEC/restic.pw /var/lib/c35/restic.pw
# roles for the globals check (password given by a random value, never printed)
runuser -u postgres -- psql -X -q -p $PGPORT -d postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='s2_app') THEN CREATE ROLE s2_app LOGIN PASSWORD '$(openssl rand -hex 12)'; END IF; END \$\$; GRANT s2_owner TO s2_app; GRANT SELECT ON ALL TABLES IN SCHEMA public TO s2_reader;" 2>&1 | tail -1
# ---- local repository
RD=/etc/exponetdb-node/repositories/$RESTIC
rm -rf $RR $RD; install -d -m0700 -o postgres -g postgres $RR; install -d -m0755 $RD
install -m0600 $SEC/restic.pw $RD/password; echo "$RR" > $RD/repository; echo owned > $RD/mode; chmod 0644 $RD/mode $RD/repository
runuser -u postgres -- restic init --no-cache --repo $RR --password-file /var/lib/c35/restic.pw | head -1
# ---- S3 repository (credentials only in root-owned 0600 files)
RD3=/etc/exponetdb-node/repositories/$RESTICS3
rm -rf $RD3 /srv/work/s2/s3data/s2-restic/*; install -d -m0755 $RD3
install -m0600 $SEC/restic.pw $RD3/password; echo "s3:https://s3.s2.test/s2-restic" > $RD3/repository; echo owned > $RD3/mode; chmod 0644 $RD3/mode $RD3/repository
( umask 077; printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' "$(cat $SEC/s3.ak)" "$(cat $SEC/s3.sk)" > $RD3/env )
runuser -u postgres -- env AWS_ACCESS_KEY_ID=$(cat $SEC/s3.ak) AWS_SECRET_ACCESS_KEY=$(cat $SEC/s3.sk) restic init --no-cache --repo s3:https://s3.s2.test/s2-restic --password-file /var/lib/c35/restic.pw | head -1
logical() { # name repoJson
  local name=$1 rj=$2 R=$(rid) T0=$(ts) out T1 snap
  c backup.run "{\"cluster\":$CLUSTER,\"repository\":$rj,\"runId\":\"$R\",\"kind\":\"logical\",\"databases\":[\"app\"]}" | jq -c '.error // {started:.result.runId}'
  out=$(wait_run $R 3600); T1=$(ts); echo "$out" > $LOGS/logical-$name.result.json
  snap=$(echo "$out"|jq -r '.result.outcome.label')
  local pst=$(echo "$out"|jq -r .result.startedAt) pfi=$(echo "$out"|jq -r .result.finishedAt)
  echo "[$name] logical: state=$(echo "$out"|jq -r .result.state) snapshot=${snap:0:12} wall=$(echo "$T1 - $T0"|bc)s product startedAt=$pst finishedAt=$pfi exit=$(echo "$out"|jq -r .result.exitCode)"
  echo "$out" | jq -r .result.excerpt | tail -6 | cut -c1-240
  note "backup.logical.$name" "snapshot=${snap:0:12} state=$(echo "$out"|jq -r .result.state)" "$(echo "$T1 - $T0"|bc)" "" "product_started=$pst product_finished=$pfi"
  local T2=$(ts); c backup.list "{\"cluster\":$CLUSTER,\"repository\":$rj}" | jq -c '.result|{engineVersion,backups:[.backups[]|{label:.label[0:12],kind,sizeBytes}]}' ; echo "backup.list: $(echo "$(ts) - $T2"|bc)s"
  R2=$(rid); T2=$(ts); c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$rj,\"runId\":\"$R2\",\"label\":null,\"snapshot\":null}" >/dev/null
  local v=$(wait_run $R2 3600); echo "[$name] verify: $(echo "$v"|jq -c '.result|{state,verifyErrors:.outcome.verifyErrors}') in $(echo "$(ts) - $T2"|bc)s"
  note "backup.verify.logical.$name" "restic check subset" "$(echo "$(ts) - $T2"|bc)" "" "$(echo "$v"|jq -c '.result|{state,verifyErrors:.outcome.verifyErrors}')"
}
logical local "$RESTICJ"
echo "local repo bytes: $(du -sb $RR|cut -f1)"; runuser -u postgres -- restic ls -l --no-cache --repo $RR --password-file /var/lib/c35/restic.pw latest 2>&1 | tail -8
logical s3 "$RESTICSJ"
echo "s3 repo bytes: $(du -sb /srv/work/s2/s3data/s2-restic|cut -f1)"; runuser -u postgres -- env AWS_ACCESS_KEY_ID=$(cat $SEC/s3.ak) AWS_SECRET_ACCESS_KEY=$(cat $SEC/s3.sk) restic ls -l --no-cache --repo s3:https://s3.s2.test/s2-restic --password-file /var/lib/c35/restic.pw latest 2>&1 | tail -8
echo C1-DONE

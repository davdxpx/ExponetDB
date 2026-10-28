source /root/lab/lib.sh
exec > >(tee $LOGS/t5-restore-refusals.log) 2>&1
SCR=/var/lib/exponetdb-node-engine/scratch; RUNS=/var/lib/exponetdb-node-engine/runs
mode owned; bind
F1=20261027-201556F
NULLT='{"label":null,"time":null,"lsn":null,"timeline":null}'
snap() { echo "scratch=$(ls $SCR|wc -l) runs=$(ls $RUNS|wc -l)"; }
prep() { c restore.prepare "{\"cluster\":${CL:-$CLUSTER},\"repository\":${RP:-$REPOJ},\"runId\":\"$1\",\"purpose\":\"drill\",\"target\":${2:-$NULLT}}" $3 $4 $5 $6; }
exec_() { c restore.execute "{\"cluster\":${CL:-$CLUSTER},\"repository\":${RP:-$REPOJ},\"runId\":\"$1\",\"purpose\":\"drill\",\"target\":${2:-$NULLT},\"port\":${3:-55400},\"checks\":[\"probe_simple\"],\"rowCounts\":[]}" $4 $5 $6 $7; }
echo "=== 1. existing scratch directory"
R=$(rid); install -d -m0700 -o postgres -g postgres $SCR/$R; echo keep > $SCR/$R/planted; chown postgres $SCR/$R/planted; B=$(snap)
echo "prepare: $(prep $R | jq -c '.result|{scratchFree,refusals}')"
echo "execute: $(exec_ $R | jq -c '.error // .result')"
echo "before $B after $(snap); scratch content: $(ls -A $SCR/$R | tr '\n' ' ') ; stat $(stat -c '%U:%G %a' $SCR/$R)"
echo "=== 2. wrong node (job for another node)"; B=$(snap); R=$(rid)
echo "prepare: $(prep $R "$NULLT" -node nod_01JB2Z6G8M4Q7R9T1V3W5X7Y8Z | jq -c '.error // .result')"
echo "execute: $(exec_ $R "$NULLT" 55400 -node nod_01JB2Z6G8M4Q7R9T1V3W5X7Y8Z | jq -c '.error // .result')"; echo "before $B after $(snap)"
echo "=== 3. wrong cluster id (system identifier)"; B=$(snap); R=$(rid)
CL='{"localName":"17/exdbnode","systemIdentifier":"1234567890123456789"}'
echo "prepare: $(CL=$CL prep $R | jq -c '.error // .result')"; echo "execute: $(CL=$CL exec_ $R | jq -c '.error // .result')"; echo "before $B after $(snap)"
CL='{"localName":"17/unknown","systemIdentifier":"'$SYSID'"}'
echo "unknown local name prepare: $(CL=$CL prep $R | jq -c '.error // .result')"; unset CL
echo "=== 4. stale source: label that was expired (F1)"; R=$(rid)
echo "prepare: $(prep $R "{\"label\":\"$F1\",\"time\":null,\"lsn\":null,\"timeline\":null}" | jq -c '.error // .result|{refusals,engineCanRead}')"
echo "execute: $(exec_ $R "{\"label\":\"$F1\",\"time\":null,\"lsn\":null,\"timeline\":null}" | jq -c '.error // .result')"; sleep 1
echo "   run (if started): $(wait_run $R 120 2>&1 | jq -c '.result|{state,excerpt:(.excerpt|.[0:200])}' 2>/dev/null)"
echo "=== 5. duplicate restore: same run id twice, and same job replayed"
R=$(rid); prep $R > /dev/null
J=job_$(tr -dc '0-7' </dev/urandom | head -c1)$(tr -dc '0-9A-HJKMNP-TV-Z' </dev/urandom | head -c25)
echo "first : $(exec_ $R "$NULLT" 55400 -jobid $J | jq -c '.error // .result')"
echo "same jobId replay: $(exec_ $R "$NULLT" 55400 -jobid $J | jq -c '.error // .result')"
echo "same runId, new job (while running): $(exec_ $R | jq -c '.error // .result')"
echo "=== 6. concurrent job: second restore and a backup while the first restore runs"
R2=$(rid); echo "second restore (other runId, same cluster): $(prep $R2 | jq -c '.result.refusals') / $(exec_ $R2 "$NULLT" 55401 | jq -c '.error // .result')"
RB=$(rid); echo "backup.run incremental during restore: $(c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$RB\",\"kind\":\"incremental\",\"databases\":[]}" | jq -c '.error // .result|{runId}')"
wait_run $R 600 | jq -c '.result|{state}'; wait_run $RB 300 | jq -c '.result|{state,label:.outcome.label}'
echo "=== 7. concurrent backups: full then differential"
RF=$(rid); RD=$(rid); c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$RF\",\"kind\":\"incremental\",\"databases\":[]}" | jq -c '.error // .result|{runId}'
echo "second backup: $(c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$RD\",\"kind\":\"differential\",\"databases\":[]}" | jq -c '.error // .result')"
echo "expire during backup: $(c backup.expire "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$(rid)\",\"retention\":{\"fullCount\":3,\"differentialCount\":null,\"logicalDays\":null},\"keepLabels\":[]}" | jq -c '.error // .result')"
wait_run $RF 300 | jq -c '.result|{state}'
echo "=== 8. another cluster's stanza (stanza 'other' bound to a second repository id)"
REPO2=bkr_01M70000000000000000000003
if ! pg_lsclusters -h | grep -q " other "; then
  pg_createcluster 17 other -p 55430 >/dev/null; 
  cat >> /etc/pgbackrest/pgbackrest.conf <<CONF
[other]
pg1-path=/var/lib/postgresql/17/other
pg1-port=55430
pg1-socket-path=/var/run/postgresql
CONF
  cat > /etc/postgresql/17/other/conf.d/50-backup.conf <<CONF
archive_mode = on
archive_command = 'pgbackrest --stanza=other archive-push %p'
wal_level = replica
CONF
  chown postgres: /etc/postgresql/17/other/conf.d/50-backup.conf; pg_ctlcluster 17 other start; sleep 2
  runuser -u postgres -- pgbackrest --stanza=other stanza-create; runuser -u postgres -- pgbackrest --stanza=other --type=full backup 2>&1 | tail -1
fi
install -d -m0755 /etc/exponetdb-node/repositories/$REPO2; echo owned > /etc/exponetdb-node/repositories/$REPO2/mode; printf 'stanza=other\nrepo=1\n' > /etc/exponetdb-node/repositories/$REPO2/pgbackrest; chmod 644 /etc/exponetdb-node/repositories/$REPO2/*
RP2='{"repositoryId":"'$REPO2'","engine":"pgbackrest","stanza":"other","repoIndex":1}'
B=$(snap); R=$(rid)
echo "backup.list stanza other as cluster exdbnode: $(c backup.list "{\"cluster\":$CLUSTER,\"repository\":$RP2}" | jq -c '.error // .result.stanza')"
echo "backup.run: $(c backup.run "{\"cluster\":$CLUSTER,\"repository\":$RP2,\"runId\":\"$R\",\"kind\":\"full\",\"databases\":[]}" | jq -c '.error // .result')"
echo "backup.expire: $(c backup.expire "{\"cluster\":$CLUSTER,\"repository\":$RP2,\"runId\":\"$(rid)\",\"retention\":{\"fullCount\":1,\"differentialCount\":null,\"logicalDays\":null},\"keepLabels\":[]}" | jq -c '.error // .result')"
echo "backup.verify: $(c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$RP2,\"runId\":\"$(rid)\",\"label\":null,\"snapshot\":null}" | jq -c '.error // .result')"
echo "restore.prepare: $(RP=$RP2 prep $R | jq -c '.error // .result|{engineCanRead,refusals}')"
echo "restore.execute: $(RP=$RP2 exec_ $R | jq -c '.error // .result')"; echo "before $B after $(snap)"
echo "binding of the repo id says stanza=exdbnode but the job names stanza other:"; echo "backup.run: $(c backup.run "{\"cluster\":$CLUSTER,\"repository\":{\"repositoryId\":\"$REPO\",\"engine\":\"pgbackrest\",\"stanza\":\"other\",\"repoIndex\":1},\"runId\":\"$(rid)\",\"kind\":\"full\",\"databases\":[]}" | jq -c '.error // .result')"
echo "=== final leak check"; systemctl list-units 'exponetdb-run-*' --all --no-legend | wc -l; ss -ltn | grep -cE ':554[0-9][0-9] ' ; pgrep -fa "postgres -D $SCR" | head -3 || true

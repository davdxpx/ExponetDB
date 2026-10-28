source /root/lab/lib.sh
exec > >(tee $LOGS/t4-host-modes.log) 2>&1
RUNS=/var/lib/exponetdb-node-engine/runs
D=/etc/exponetdb-node/repositories/$REPO
nruns() { ls $RUNS | wc -l; }
try() { # label kind -> prints verdict, run dirs delta
  local lbl=$1 kind=$2 n0=$(nruns) R=$(rid)
  local out; out=$(c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"kind\":\"$kind\",\"databases\":[]}")
  local code=$(echo "$out" | jq -r '.error.code // "STARTED"')
  printf '%-48s kind=%-12s -> %-22s %s | rundirs %s->%s\n' "$lbl" "$kind" "$code" "$(echo "$out" | jq -r '.error.message // ""' | cut -c1-90)" $n0 $(nruns)
  if [ "$code" = STARTED ]; then wait_run $R 300 | jq -r '"   run ended: "+.result.state+" "+(.result.outcome.label//"")'; fi
}
echo "### binding present for all cases below unless noted"
bind
mode absent;            try "mode file absent" full; try "mode file absent" incremental
mode adopted_observed;  try "adopted_observed" incremental
mode adopted_runs;      try "adopted_runs" full; try "adopted_runs" differential; try "adopted_runs" incremental
echo "# expire on adopted_runs:"
R=$(rid); c backup.expire "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"retention\":{\"fullCount\":2,\"differentialCount\":null,\"logicalDays\":null},\"keepLabels\":[]}" | jq -c '.error // .result'
mode owned;             try "owned" differential
echo "### unsafe mode files"
mode adopted_runs
chown postgres:postgres $D/mode;           try "mode file owned by postgres" incremental
chown root:root $D/mode; chmod 0666 $D/mode;  try "mode file mode 0666 (world-writable)" incremental
chmod 0664 $D/mode;                           try "mode file mode 0664 (group-writable)" incremental
chmod 0644 $D/mode; echo "adopted_runs extra" > $D/mode; try "mode file 'adopted_runs extra'" incremental
echo "bogus" > $D/mode;                       try "mode file unknown word" incremental
echo "OWNED" > $D/mode;                       try "mode file wrong case" incremental
: > $D/mode;                                  try "mode file empty" incremental
rm -f $D/mode; ln -s /etc/passwd $D/mode;     try "mode file is a symlink to /etc/passwd" incremental
rm -f $D/mode; mode adopted_runs
chown postgres:postgres $D; chmod 0775 $D;    try "repository dir owned by postgres 0775" incremental
chown root:root $D; chmod 0755 $D
echo "### binding file cases (mode adopted_runs)"
mode adopted_runs
rm -f $D/pgbackrest;                                  try "no binding file" incremental
printf 'stanza=other\nrepo=1\n' > $D/pgbackrest;      try "binding stanza=other" incremental
printf 'stanza=exdbnode\nrepo=2\n' > $D/pgbackrest;   try "binding repo=2" incremental
bind; chown postgres:postgres $D/pgbackrest;          try "binding owned by postgres" incremental
chown root:root $D/pgbackrest; chmod 0666 $D/pgbackrest; try "binding world-writable" incremental
chmod 0644 $D/pgbackrest
echo "### restored good state"
mode adopted_runs; try "adopted_runs (good again)" incremental
mode owned; bind
ls -la $D

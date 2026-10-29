#!/usr/bin/env bash
# S4 task 4 (I14), part 2: giant and deeply nested bundle content, a symlink and path traversal; CPU and RSS of serve and worker per plan.
source /srv/work/s4/env.sh
cd $S4; refresh_creds
TP=lab/platform/s4cont
SERVE=$(systemctl show -p MainPID --value exstack-serve.service); WORK=$(systemctl show -p MainPID --value exstack-worker.service)
rss() { awk '/VmRSS/{printf "%d",$2/1024}' /proc/$1/status; }
cpu() { awk '{print $14+$15}' /proc/$1/stat; }
run() { # name  generator-command  (writes up.sql to stdout)
  local k=$1; P=$(new_project s4h-$k 2>/dev/null); id=$(mkb $P "s4h-$k" </dev/null)
  d=$(ls -d $P/migrations/${id}_*); eval "$2" > $d/up.sql
  local sz=$(stat -c %s $d/up.sql)
  s0=$(cpu $SERVE); w0=$(cpu $WORK); b=$(rss $SERVE); bw=$(rss $WORK)
  ( while :; do echo "$(rss $SERVE) $(rss $WORK)"; sleep 0.05; done > $L4/rss2.$k ) & SPID=$!
  local t0=$(date +%s.%N)
  lint=$(cd $P && timeout 120 exdb migration lint 2>&1 | grep -E 'BLOCKED|OK |Error' | head -1 | cut -c1-90)
  t1=$(date +%s.%N)
  planline=$(timeout 170 bash -c "source /srv/work/s4/env.sh; mplan $P $TP" 2>&1 | head -1 | cut -c1-110)
  t2=$(date +%s.%N)
  kill $SPID 2>/dev/null; wait $SPID 2>/dev/null
  ps_=$(awk '{if($1>a)a=$1; if($2>b)b=$2} END{print a" "b}' $L4/rss2.$k); rm -f $L4/rss2.$k
  printf '%-22s %7s B  lint %5.1fs [%s]  plan %5.1fs [%s]  CPU serve+worker %ss  RSS serve %s->%s MiB worker %s->%s MiB\n' "$k" "$sz" "$(echo "$t1-$t0"|bc)" "$lint" "$(echo "$t2-$t1"|bc)" "$planline" "$(( ($(cpu $SERVE)-s0+$(cpu $WORK)-w0)/100 ))" "$b" "${ps_% *}" "$bw" "${ps_#* }"
}
run many-statements   "python3 -c \"print('\n'.join('SELECT %d;' % i for i in range(60000)))\""
run deep-parens       "python3 -c \"print('SELECT ' + '('*20000 + '1' + ')'*20000 + ';')\""
run deep-nested-comment "python3 -c \"print('/*'*50000 + '*/'*50000 + ' SELECT 1;')\""
run huge-literal      "python3 -c \"print(\\\"SELECT '\\\" + 'A'*950000 + \\\"';\\\")\""
run long-identifier-chain "python3 -c \"print('SELECT ' + ' + '.join(['1']*30000) + ';')\""
run dollar-quote-bomb "python3 -c \"print('DO \$x\$ BEGIN ' + 'PERFORM 1; '*40000 + 'END \$x\$;')\""
echo "== symlink in a bundle directory (the client reads files it is pointed at)"
P=$(new_project s4h-symlink 2>/dev/null); id=$(mkb $P s4h-symlink </dev/null); d=$(ls -d $P/migrations/${id}_*); rm $d/up.sql; ln -s /etc/hostname $d/up.sql
(cd $P && exdb migration lint 2>&1 | head -3 | cut -c1-160); mplan $P $TP | cut -c1-120
echo "== path traversal in the bundle directory name"
P=$(new_project s4h-traversal 2>/dev/null); mkdir -p "$P/migrations/../../traversal-x"; ls $P/migrations | head -2
mkdir -p "$P/migrations/01M64SGMPHM0TRYKBRWHJ1G4EN_x"; ln -s ../../../../tmp "$P/migrations/01M64SGMPHM0TRYKBRWHJ1G4EP_y"
(cd $P && exdb migration lint 2>&1 | head -4 | cut -c1-160)

#!/usr/bin/env bash
# graceful-life step 7 (and the limits table): request bodies of 100 KB / 1 MB / 100 MB (content-length and chunked),
# a bundle body near and above 32 MiB, a slow header and a slow body; the named error of each.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/gl-limits.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
bearer
D18=$(jq -r .target_dev18 ${EXSTACK_STATE}/ids.json); P=$(jq -r .project ${EXSTACK_STATE}/ids.json)
SP=$(systemctl show -p MainPID --value $(_stk_unit serve)); rss() { awk '/VmRSS/{print int($2/1024)}' /proc/$SP/status; }
W6=/dev/shm/s6lim; mkdir -p $W6
mkjson() { # bytes file : {"sql":"select '<x...>'"}
  { printf '{"sql":"select '"'"; head -c $(( $1 - 20 )) /dev/zero | tr '\0' 'x'; printf '"'"'"}'; } >$2; }
call() { # label file path extra...
  local l="$1" f="$2" p="$3"; shift 3
  local r; r=$(curl -s -m 120 -o $W6/resp -w '%{http_code} %{time_total}s' -H @$HDR -H 'content-type: application/json' "$@" --data-binary @$f $API$p)
  printf '%-34s %s rss=%sMB | %s\n' "$l" "$r" "$(rss)" "$(head -c 420 $W6/resp | tr '\n' ' ')"
}
echo "== query route (default REST body limit)"
for sz in 1024 65000 70000 102400 1048576 104857600; do mkjson $sz $W6/q.json; call "query body $sz B" $W6/q.json /api/v1/targets/$D18/queries; done
echo "-- chunked 100 MB"
mkjson 104857600 $W6/q.json; r=$(curl -s -m 120 -o $W6/resp -w '%{http_code} %{time_total}s' -H @$HDR -H 'content-type: application/json' -H 'Transfer-Encoding: chunked' --data-binary @$W6/q.json $API/api/v1/targets/$D18/queries); echo "chunked 100 MB: $r | $(head -c 300 $W6/resp)"
echo "-- content-length lie: header says 10, sends 70000"
head -c 70000 /dev/zero | tr '\0' 'x' >$W6/lie; (printf 'POST /api/v1/targets/%s/queries HTTP/1.1\r\nHost: x\r\nAuthorization: %s\r\nContent-Type: application/json\r\nContent-Length: 10\r\nConnection: close\r\n\r\n' "$D18" "$(cut -d' ' -f2- $HDR | sed 's/^Bearer //;s/^/Bearer /')"; cat $W6/lie) | timeout 10 nc 127.0.0.1 $EXSTACK_PORT_SERVE | head -c 300 | tr '\r\n' '  '; echo
echo "== bundle route (32 MiB)"
node - <<'JS'
const fs=require('fs');const mk=(n)=>JSON.stringify({bundles:[{directory:'01HZZZZZZZZZZZZZZZZZZZZZZZ_x',files:{'migration.yaml':'x','up.sql':'-- '+'a'.repeat(n)}}]});
fs.writeFileSync('/dev/shm/s6lim/b31.json',mk(31*1048576));fs.writeFileSync('/dev/shm/s6lim/b33.json',mk(33*1048576));fs.writeFileSync('/dev/shm/s6lim/b100.json',mk(100*1048576));
JS
for f in b31 b33 b100; do call "bundles $f" $W6/$f.json /api/v1/projects/$P/bundles; done
echo "== slow client"
echo "-- slow headers (1 byte/s) until the server closes:"
( t0=$(date +%s); { printf 'POST /api/v1/targets HTTP/1.1\r\nHost: x\r\n'; for i in $(seq 1 40); do printf 'X-Slow-%s: 1\r\n' $i; sleep 1; done; } | timeout 60 nc 127.0.0.1 $EXSTACK_PORT_SERVE >/dev/null 2>&1; echo "closed by the server after $(( $(date +%s) - t0 )) s" )
echo "-- slow body (headers fast, 70000 B at ~100 B/s):"
( t0=$(date +%s); head -c 3000 /dev/zero | tr '\0' 'x' > $W6/slow.json; timeout 200 curl -s -o /dev/null -w 'http=%{http_code}\n' --limit-rate 100 -H @$HDR -H 'content-type: application/json' --data-binary @$W6/slow.json $API/api/v1/saved-queries; echo "elapsed $(( $(date +%s) - t0 )) s" )
echo "== serve after: ready=$(hc $S) rss=$(rss)MB"
rm -rf $W6

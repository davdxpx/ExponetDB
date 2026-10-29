#!/usr/bin/env bash
# graceful-life step 7 (and the limits table): request bodies of 100 KB / 1 MB / 100 MB (content-length and chunked),
# a bundle body near and above 32 MiB, a slow header and a slow body; the named error of each.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/gl-limits.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
bearer
D18=$(jq -r .target_dev18 ${EXSTACK_STATE}/ids.json); P=$(jq -r .project ${EXSTACK_STATE}/ids.json)
SP=$(systemctl show -p MainPID --value $(_stk_unit serve)); rss() { awk '/VmRSS/{print int($2/1024)}' /proc/$SP/status; }
W6=/dev/shm/s6lim; rm -rf $W6; mkdir -p $W6
cat >$W6/mk.js <<'JS'
const fs = require('fs')
const [kind, n, out] = process.argv.slice(2)
const N = Number(n)
if (kind === 'query') fs.writeFileSync(out, JSON.stringify({ sql: "select '" + 'x'.repeat(N - 30) + "'" }))
else fs.writeFileSync(out, JSON.stringify({ bundles: [{ directory: '01HZZZZZZZZZZZZZZZZZZZZZZZ_x', files: { 'migration.yaml': 'x', 'up.sql': '-- ' + 'a'.repeat(N) } }] }))
JS
call() { # label file path extra...
  local l="$1" f="$2" p="$3"; shift 3
  local r; r=$(curl -s -m 120 -o $W6/resp -w '%{http_code} %{time_total}s' -H @$HDR -H 'content-type: application/json' "$@" --data-binary @$f $API$p)
  printf '%-30s %s rss=%sMB | %s\n' "$l" "$r" "$(rss)" "$(head -c 420 $W6/resp | tr '\n' ' ')"
}
echo "baseline rss=$(rss)MB"
echo "== query route (default REST body limit 64 KiB)"
for sz in 1024 65000 70000 102400 1048576 104857600; do node $W6/mk.js query $sz $W6/q.json; call "query body $sz B" $W6/q.json /api/v1/targets/$D18/queries; done
echo "-- chunked 100 MB"
r=$(curl -s -m 120 -o $W6/resp -w '%{http_code} %{time_total}s' -H @$HDR -H 'content-type: application/json' -H 'Transfer-Encoding: chunked' --data-binary @$W6/q.json $API/api/v1/targets/$D18/queries); echo "chunked 100 MB: $r | $(head -c 300 $W6/resp)"
echo "-- content-length says 10, 70000 bytes follow"
head -c 70000 /dev/zero | tr '\0' 'x' >$W6/lie
{ printf 'POST /api/v1/targets/%s/queries HTTP/1.1\r\nHost: x\r\n%s\r\nContent-Type: application/json\r\nContent-Length: 10\r\nConnection: close\r\n\r\n' "$D18" "$(cat $HDR)"; cat $W6/lie; } | timeout 10 nc 127.0.0.1 $EXSTACK_PORT_SERVE | head -c 400 | tr '\r\n' '  '; echo
echo "== bundle route (32 MiB limit)"
for n in 31 33 100; do node $W6/mk.js bundle $((n*1048576)) $W6/b$n.json; call "bundles ~$n MiB" $W6/b$n.json /api/v1/projects/$P/bundles; done
echo "== slow client"
echo "-- slow headers (one header line per second) until the server closes:"
t0=$(date +%s); { printf 'POST /api/v1/targets HTTP/1.1\r\nHost: x\r\n'; for i in $(seq 1 40); do printf 'X-Slow-%s: 1\r\n' $i; sleep 1; done; } | timeout 60 nc 127.0.0.1 $EXSTACK_PORT_SERVE >/dev/null 2>&1; echo "connection ended after $(( $(date +%s) - t0 )) s"
echo "-- slow body (headers at once, 3000 bytes at 100 B/s = 30 s; limit is the 120 s request timeout):"
head -c 3000 /dev/zero | tr '\0' 'x' > $W6/slow.json; t0=$(date +%s); timeout 200 curl -s -o /dev/null -w 'http=%{http_code}\n' --limit-rate 100 -H @$HDR -H 'content-type: application/json' --data-binary @$W6/slow.json $API/api/v1/saved-queries; echo "elapsed $(( $(date +%s) - t0 )) s"
echo "-- slow body that never ends (1 byte every 5 s): how long is the connection kept?"
t0=$(date +%s); { printf 'POST /api/v1/saved-queries HTTP/1.1\r\nHost: x\r\n%s\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n' "$(cat $HDR)"; for i in $(seq 1 40); do printf 'x'; sleep 5; done; } | timeout 220 nc 127.0.0.1 $EXSTACK_PORT_SERVE | head -c 300 | tr '\r\n' '  '; echo; echo "connection ended after $(( $(date +%s) - t0 )) s"
echo "== serve after: ready=$(hc $S) rss=$(rss)MB"
rm -rf $W6

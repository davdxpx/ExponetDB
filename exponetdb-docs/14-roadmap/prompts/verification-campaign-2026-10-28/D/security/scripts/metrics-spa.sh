source /srv/work/s4/env.sh; cd $S4; mkdir -p $L4/metrics
for port in 58481 58482 58483; do for p in /metrics /healthz/ready /healthz/live /healthz/startup /debug /status /traces /version; do
  c=$(curl -s -m 3 -o $L4/metrics/$port$(echo $p | tr / _).txt -w '%{http_code}' http://127.0.0.1:$port$p); [ "$c" != 404 ] && echo "$port $p $c $(wc -c < $L4/metrics/$port$(echo $p | tr / _).txt)B"; done; done
# public listener: unauthenticated surfaces
for p in /healthz/ready /metrics /.well-known/oauth-authorization-server /api/v1/openapi.json /openapi.json /docs /api/v1/docs /robots.txt /; do
  c=$(curl -s -m 3 -o $L4/metrics/pub$(echo $p | tr / _).txt -w '%{http_code}' http://127.0.0.1:58480$p); echo "58480 $p $c $(wc -c < $L4/metrics/pub$(echo $p | tr / _).txt)B"; done
# SPA assets
curl -s http://127.0.0.1:58480/ | grep -oE '(src|href)="[^"]+\.(js|css)"' | head -5
for a in $(curl -s http://127.0.0.1:58480/ | grep -oE '(src|href)="/[^"]+\.js"' | cut -d'"' -f2 | head -10); do curl -s http://127.0.0.1:58480$a -o $L4/metrics/spa$(echo $a | tr / _); done
grep -raoF -f $S4/patterns.txt $L4/metrics | python3 $S4/attr.py metrics-and-spa --files

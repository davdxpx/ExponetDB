#!/usr/bin/env bash
# S7 task 1: the product's own refusal of CIMD client ids that point at this machine, through the real authorization endpoint
# (open registration is the lab's setting). Only requests to 127.0.0.1:58480; no payload beyond a client_id URL. Records what the endpoint
# answers, what the rate limiter counted and which audit/log lines exist.
source /srv/work/s7/env.sh
L7=${L7:-/srv/work/logs-s7}; B=http://127.0.0.1:58480
CH=$(printf 'x%.0s' $(seq 1 43))   # a syntactically valid PKCE challenge (43 chars)
ask() { # label client_id
  local cid; cid=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$2")
  local out; out=$(curl -s -m 20 -o "$L7/cimd-$1.body" -D "$L7/cimd-$1.head" -w '%{http_code} %{redirect_url}' \
    "$B/oauth/authorize?response_type=code&client_id=$cid&redirect_uri=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "${3:-https://client.example.test/cb}")&code_challenge=$CH&code_challenge_method=S256&state=s7&resource=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("http://localhost:58480/mcp",safe=""))')&scope=targets.read")
  printf '%-34s %s\n' "$1" "$(echo "$out" | cut -c1-200)"
}
buckets() { ctl_sql "select bucket||' hits='||hits from oauth.rate_limits where bucket like 'dcr-%' order by bucket" | tr '\n' ' ' | cut -c1-200; }
echo "rate buckets before: $(buckets)"
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ask loopback-ip        "https://127.0.0.1/client.json"
ask localhost          "https://localhost/client.json"
ask ipv6-loopback      "https://[::1]/client.json"
ask metadata-ip        "https://169.254.169.254/latest/meta-data"
ask decimal-ip         "https://2130706433/client.json"
ask userinfo           "https://client.example.com@127.0.0.1/client.json"
ask http-scheme        "http://client.example.test/client.json"
ask dns-name-to-loopback "https://localtest.me/client.json"
ask nip-loopback       "https://127.0.0.1.nip.io/client.json"
ask unresolvable-name  "https://no-such-host.s7.invalid-name.example/client.json"
echo "rate buckets after: $(buckets)"
echo "--- what the endpoint's answer bodies say (first 160 bytes of two):"
head -c 160 "$L7/cimd-loopback-ip.body"; echo; head -c 160 "$L7/cimd-nip-loopback.body"; echo
echo "--- clients created by these requests (expect none): $(ctl_sql "select count(*) from oauth.clients where external_id like 'https://127.%' or external_id like '%nip.io%' or external_id like '%localtest.me%' or external_id like 'https://localhost%'")"
echo "--- audit/log traces since $T0:"
journal serve --since "$T0" --no-pager 2>/dev/null | grep -ciE "cimd|client_metadata|oauth.client" | sed 's/^/serve journal lines mentioning cimd or client metadata: /'
ctl_sql "select count(*) from audit.audit_events where occurred_at >= '$T0' and action like 'oauth.client%'" 2>&1 | sed 's/^/audit rows oauth.client* since start: /' | head -2

#!/usr/bin/env bash
# fail-closed step 10: keyring cases (a) none/empty, (b) a keyring without the referenced key, (c) a different key under a known id.
# A second serve on spare ports with a modified environment (the running stack is untouched).
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc10.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
W6=$(mktemp -d /dev/shm/s6kr.XXXX); chmod 700 $W6
KID=$(jq -r '.keys[0].keyId' ${EXSTACK_STATE}/keyring.json)
node_run keyring generate --key-id s6other --output $W6/other.json >/dev/null 2>&1
variant() { # name keyring-json-or-empty
  local name="$1" kr="$2" env=$W6/$1.env
  grep -v '^EXPONETDB_KEYRING=\|^EXPONETDB_LISTEN=\|^EXPONETDB_INTERNAL_LISTEN=' ${EXSTACK_STATE}/env/serve.env >$env
  echo "EXPONETDB_LISTEN=127.0.0.1:58990" >>$env; echo "EXPONETDB_INTERNAL_LISTEN=127.0.0.1:58991" >>$env
  [ "$kr" != "-" ] && echo "EXPONETDB_KEYRING=$kr" >>$env
  chmod 644 $env
  echo "== variant $name"
  ( sleep 9; echo "   t=9 ready=$(hc 127.0.0.1:58991) detail=$(curl -s -m 3 http://127.0.0.1:58991/healthz/detail | jq -c '[.status,(.checks[]?|select(.status!="pass")|{name,status,reason})]' 2>/dev/null)" ) &
  local BG=$!
  systemd-run --quiet --wait --pipe --collect -p User=exstack -p EnvironmentFile=$env -p RuntimeMaxSec=14 -p ProtectSystem=strict \
    /usr/local/bin/node --liftoff-only ${EXSTACK_BUNDLE} serve 2>&1 | jq -rc 'select(.level=="error" or .level=="warn" or .msg=="process.started" or .msg=="process.start_refused")|[.msg,.reason,.check,.code]|@tsv' 2>/dev/null | head -8
  echo "   systemd result/status: $(systemctl show -p Result,ExecMainStatus run-*.service 2>/dev/null | tr '\n' ' ')"
  wait $BG
}
echo "installation key id: $KID"
variant a-none -
variant b-empty-object '{}'
variant c-other-key-id "$(jq -c . $W6/other.json)"
variant d-same-id-other-material "$(jq -c --arg k "$KID" '.keys[0].keyId=$k' $W6/other.json)"
# the exit code of a refused start, read directly
for v in a-none; do ( set -a; . $W6/$v.env; set +a; timeout 20 runuser -u exstack -- env -i PATH=$PATH $(grep -v KEYRING $W6/$v.env | xargs -d '\n' echo | tr '\n' ' ') /usr/local/bin/node --liftoff-only ${EXSTACK_BUNDLE} serve >/dev/null 2>&1; echo "direct run exit code ($v): $?" ); done
rm -rf $W6
echo "stack still ready: serve=$(hc $S)"

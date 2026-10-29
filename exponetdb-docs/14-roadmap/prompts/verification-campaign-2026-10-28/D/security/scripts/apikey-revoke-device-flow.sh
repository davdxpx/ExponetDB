source /srv/work/s4/env.sh; cd $S4
SA=$(cat $S4/sa.id)
s4ts s4/ident.ts apikey $SA revoked-key nonprod,prod 2>&1 | tail -1
KID=$(curl -s -H "Authorization: Bearer $(cat creds/owner.token)" http://127.0.0.1:58480/api/v1/api-keys | jq -r '.items[]|select(.label=="revoked-key")|.id')
s4ts s4/req.ts revoke-key --reauth POST /api/v1/api-keys/$KID/revoke '{"reason":"s4 test"}' 2>&1 | tail -1
curl -s -o $L4/api/revoked-key-use.json -w 'revoked key use %{http_code}\n' -H "Authorization: Bearer $(cat creds/revoked-key.token)" http://127.0.0.1:58480/api/v1/targets
jq -c '{code}' $L4/api/revoked-key-use.json
# device flow through the CLI
cfg=$S4/cli/device; mkdir -p $cfg; chmod 700 $cfg
EXPONETDB_CONFIG_DIR=$cfg "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_CLI_BIN}" profile add stack --server "${EXSTACK_PUBLIC_URL}" --use >/dev/null
out=$S4/cli/device.out; : > $out; chmod 600 $out
( EXPONETDB_CONFIG_DIR=$cfg "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_CLI_BIN}" login --device --no-browser --scope targets.read >$out 2>&1 ) &
pid=$!
for i in $(seq 1 30); do grep -qiE "code" $out && break; sleep 0.5; done
UC=$(grep -oE '[A-Z]{4}-[A-Z]{4}' $out | head -1)
echo "user code found: $([ -n "$UC" ] && echo yes || echo no)"
s4ts human.ts device-approve "$UC" targets.read 2>&1 | tail -1 | cut -c1-100
wait $pid; echo "cli device login rc=$?"
chmod -R go-rwx $cfg

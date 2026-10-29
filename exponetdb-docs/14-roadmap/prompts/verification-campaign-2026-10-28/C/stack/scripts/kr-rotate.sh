#!/usr/bin/env bash
# keys step 2 (C1-8): master key rotation in the WRONG order (worker first), observe serve, then the right order.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/kr.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
E=${EXSTACK_STATE}/env; W6=$(mktemp -d /dev/shm/s6rot.XXXX); chmod 700 $W6
getkr() { grep "^EXPONETDB_KEYRING=" $E/$1.env | cut -d= -f2- | sed "s/^'//; s/'\$//"; }   # the env files quote the JSON with single quotes
setkr() { # role keyring-json
  grep -v '^EXPONETDB_KEYRING=' $E/$1.env >$W6/$1.new; echo "EXPONETDB_KEYRING='$2'" >>$W6/$1.new; cat $W6/$1.new >$E/$1.env
}
for r in serve worker gateway; do cp -p $E/$r.env $L6/$r.env.s6orig 2>/dev/null; done   # secrets: stay on the server, 0600
chmod 600 $L6/*.s6orig
kstatus() { ( set -a; . $E/serve.env; set +a; EXPONETDB_KEYRING="$1" EXPONETDB_LOG_LEVEL=warn node_run keyring status 2>&1 | jq -c '[.keys[]? | {keyId, status, references, removable}] // .' 2>/dev/null | head -c 600 ); echo; }
getkr worker >$W6/k1.json
bearer
echo "== keyring before: $(kstatus "$(cat $W6/k1.json)")"
node_run keyring add-key --input $W6/k1.json --key-id k2 --output $W6/k2.json 2>&1 | head -2 | cut -c1-200
echo "k2 file: $(jq -c '[.keys[]|{keyId,status}]' $W6/k2.json)"
KR2=$(jq -c . $W6/k2.json)
echo "== WRONG ORDER: only the worker gets the new keyring; secrets.rewrap made due $(now)"
setkr worker "$KR2"; systemctl restart $(_stk_unit worker)
for i in $(seq 1 30); do [ "$(hc $W)" = 200 ] && break; sleep 1; done
ctl_sql "UPDATE control.maintenance_tasks SET next_run_at=now(), lease_owner=NULL, lease_expires_at=NULL WHERE task='secrets.rewrap'" >/dev/null
t0
for i in $(seq 1 24); do
  ks=$(kstatus "$KR2" | head -c 300)
  printf 't=%s serve ready=%s worker ready=%s | rewrap: %s | %s\n' "$(el)" "$(hc $S)" "$(hc $W)" "$(ctl_sql "select last_outcome||'/'||coalesce(last_reason,'-')||' '||to_char(last_finished_at,'HH24:MI:SS') from control.maintenance_tasks where task='secrets.rewrap'")" "$ks"
  [ "$(hc $S)" != 200 ] && break; sleep 5
done
echo "serve detail: $(hdetail $S | jq -c '[.status,(.checks[]?|select(.status!="pass")|{name,status,reason})]')"
echo "serve log: $(logs_since serve "-4 min" | jq -rc 'select(.level=="error" or .level=="warn")|[.msg,.code,.reason,.check]|@tsv' | sort | uniq -c | head -5 | tr '\n' '|')"
echo "owner login + reauth (TOTP) through serve: $(human call GET /api/v1/auth/session 2>&1 | tail -1 | cut -c1-200)"
echo "a read through serve with the CLI token: $(read_probe 6)"
echo "== RIGHT ORDER (completing it): serve and gateway get the new keyring $(now)"
t0
setkr serve "$KR2"; setkr gateway "$KR2"; systemctl restart $(_stk_unit serve) $(_stk_unit gateway)
for i in $(seq 1 60); do [ "$(hc $S)" = 200 ] && [ "$(hc $G)" = 200 ] && break; sleep 1; done; echo "serve+gateway ready after t=$(el): serve=$(hc $S) gw=$(hc $G)"
echo "keyring status: $(kstatus "$KR2")"
echo "== drop k1 from the keyring file and restart all three"
KR3=$(jq -c 'del(.keys[]|select(.keyId=="k1"))' $W6/k2.json); echo "k3 keys: $(printf '%s' "$KR3" | jq -c '[.keys[]|{keyId,status}]')"
for r in worker serve gateway; do setkr $r "$KR3"; done; t0
for r in gateway worker serve; do systemctl restart $(_stk_unit $r); done
for i in $(seq 1 60); do [ "$(hc $S)" = 200 ] && break; sleep 1; done
echo "ready after t=$(el): serve=$(hc $S) worker=$(hc $W) gw=$(hc $G); status: $(kstatus "$KR3")"
echo "login again: $(human call GET /api/v1/auth/session 2>&1 | tail -1 | cut -c1-120)"
rm -rf $W6

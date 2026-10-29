#!/usr/bin/env bash
# Case (ii): the keyring (master key) is lost, the Control Store is intact. What do the roles do with (a) no keyring, (b) a new keyring that
# reuses the key id k1, (c) a new keyring with a new key id? What is encrypted in the store (so what is gone)? Which CLI paths still work?
# The original env files are restored at the end.
. /srv/work/s3-infra/s3/lib.sh
s3_release new
ENVD="${EXSTACK_STATE}/env"; BK="${EXSTACK_STATE}/env.keep"; rm -rf "$BK"; cp -a "$ENVD" "$BK"
OUT="${S3_LOGS}/loss"; mkdir -p "$OUT"
echo "== what the keyring protects (secrets.secret_versions by purpose, consumer)"
psql_control -At -F ' | ' -c "select purpose, consumer, count(*) from secrets.secret_versions group by 1,2 order by 1" 
echo "== blob tables: $(for t in auth gateway observer worker; do printf '%s=%s ' $t "$(ctl_sql "select count(*) from secrets.secret_blobs_$t")"; done)"
set_keyring() { # json-or-empty  -> rewrites the EXPONETDB_KEYRING line of the three env files
  local r f; for r in serve worker gateway; do f="${ENVD}/${r}.env"; grep -v '^EXPONETDB_KEYRING=' "${BK}/${r}.env" >"$f"; [ -n "$1" ] && printf "EXPONETDB_KEYRING='%s'\n" "$1" >>"$f"; done
}
start_all() { for r in worker gateway serve; do systemctl reset-failed "$(_stk_unit $r)" 2>/dev/null; systemctl start "$(_stk_unit $r)" 2>/dev/null; done; sleep 12; }
report() { # label
  echo "--- $1"
  for r in worker gateway serve; do u="$(_stk_unit $r)"; printf '  %-8s active=%s exit=%s | %s\n' "$r" "$(systemctl is-active $u)" "$(systemctl show -p ExecMainStatus --value $u)" "$(journal $r --since '-14 sec' | grep -E 'start_refused|"level":"error"|readiness|not_ready' | tail -1 | cut -c1-220)"; done
  echo "  readiness: $(role_versions | awk '{printf "%s=%s ", $1,$2}')"
}
stop_all() { for r in serve worker gateway; do systemctl stop "$(_stk_unit $r)" 2>/dev/null; done; }
stop_all
echo "== (a) no keyring at all"
set_keyring ""; start_all; report "no EXPONETDB_KEYRING"; stop_all
echo "== (b) a brand-new keyring that reuses the key id k1"
node_run keyring generate --key-id k1 --output /tmp/newkeyring-k1.json >/dev/null 2>&1; set_keyring "$(jq -c . /tmp/newkeyring-k1.json)"; start_all; report "new keyring, same id k1"; stop_all
echo "== (c) a brand-new keyring with a new key id k2"
node_run keyring generate --key-id k2 --output /tmp/newkeyring-k2.json >/dev/null 2>&1; set_keyring "$(jq -c . /tmp/newkeyring-k2.json)"; start_all; report "new keyring, id k2"
echo "--- keyring status with the new keyring (operator command)"
( set -a; . "${ENVD}/operator-worker.env"; set +a; EXPONETDB_KEYRING="$(jq -c . /tmp/newkeyring-k2.json)" node_run keyring status 2>&1 | jq -c '{activeKeyId, keys, missing, mismatched}' 2>/dev/null | cut -c1-400 )
echo "--- what still works with (c)? CLI reads, a plan, a credential rotation, the owner's login"
echo "  target list: $(exdb target list 2>&1 | head -2 | tr '\n' '|' | cut -c1-200)"
echo "  node list:   $(exdb node list 2>&1 | head -3 | tr '\n' '|' | cut -c1-200)"
d="$(new_project kr)"; mkb "$d" kr-change <<<"CREATE TABLE public.kr (id int PRIMARY KEY); GRANT SELECT ON public.kr TO lab_owner;" >/dev/null
echo "  plan on dev16: $(cd $d && exdb migration plan --target lab/platform/dev16 2>&1 | head -2 | tr '\n' '|' | cut -c1-240)"
echo "  credential rotate (RB-14's documented recovery): $(exdb cluster credential rotate --help 2>&1 | sed -n 1,3p | tr '\n' '|' | cut -c1-200)"
echo "  readiness of serve: $(curl -s -m 3 http://127.0.0.1:${EXSTACK_PORT_INTERNAL_SERVE}/healthz/ready | cut -c1-120)"
echo "  the owner's TOTP/password login (web): $(human call GET /api/v1/installation 2>&1 | head -1 | cut -c1-200)"
stop_all
echo "== restore the original env (the offline keyring) and verify"
rm -rf "$ENVD"; cp -a "$BK" "$ENVD"; start_all; report "original keyring back"; rm -f /tmp/newkeyring-k1.json /tmp/newkeyring-k2.json
for i in $(seq 1 60); do stack_ready && break; sleep 1; done; echo "serve ready: $(stack_ready && echo yes || echo no); node: $(exdb node list 2>&1 | sed -n 4,5p | tail -1)"

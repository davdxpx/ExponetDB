#!/usr/bin/env bash
# keys steps 3, 4 and 10, plus `keyring status`, plus the installation-health `workers` component during a worker restart loop.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/kx.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
E=${EXSTACK_STATE}/env
bearer
echo "== keys step 10: certificate overview"
rest GET /api/v1/nodes/certificates | head -1; jq -c '{authorities:[.authorities[]?|{kind:(.kind // .name // .role),notBefore,notAfter:(.notAfter // .expiresAt)}], nodes:[.nodes[]?|{state,certificateExpiresAt}], serverCertificates:(.serverCertificates|length)}' /dev/shm/s6out.last | head -c 900; echo
echo "== keyring status (login exdb_serve, keyring only)"
( EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(store_url exdb_serve)" EXPONETDB_KEYRING="$(grep '^EXPONETDB_KEYRING=' $E/serve.env | cut -d= -f2- | sed "s/^'//; s/'\$//")" node_run keyring status 2>&1 | head -20 | sed 's/"key": *"[^"]*"/"key":"<x>"/' )
echo "== keys step 3: rotate-mcp-key purposes"
for p in audit.pseudonym_key auth.rate_limit_key mcp.cursor_key mcp.request_state_key; do
  r=$( EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(store_url exdb_serve)" EXPONETDB_KEYRING="$(grep '^EXPONETDB_KEYRING=' $E/serve.env | cut -d= -f2- | sed "s/^'//; s/'\$//")" node_run keyring rotate-mcp-key --purpose $p 2>&1 | head -2 | tr '\n' ' ' | cut -c1-200); echo "$p: rc=$? $r"
done
echo "secret versions: $(ctl_sql "select purpose||'='||count(*) from secrets.secret_versions group by purpose" 2>&1 | tr '\n' ' ' | cut -c1-300)"
echo "== installation health workers component during restart loop"
for i in 1 2 3; do kill_role worker KILL >/dev/null 2>&1; sleep 4; echo "killed: $(bearer; rest GET /api/v1/installation/health | head -1 >/dev/null; jq -c '[.components[]|select(.id=="workers" or .name=="workers" or .component=="workers")]' /dev/shm/s6out.last | head -c 300) serve workers: $(hdetail $S | jq -c '[.checks[]?|select(.name=="workers")|.status]')"; systemctl start $(_stk_unit worker); sleep 10; done

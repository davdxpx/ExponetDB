# sourced on the server
source /srv/work/infra-s1/stack-env.sh
export S4=/srv/work/s4 L4=/srv/work/logs-s4
s4ts() { ( cd "${EXSTACK_KIT}" && EXSTACK_OWNER_FILE="${EXSTACK_OWNER_FILE:-${EXSTACK_STATE}/owner.json}" EXSTACK_STATE="${EXSTACK_STATE}" EXSTACK_PUBLIC_URL="${EXSTACK_PUBLIC_URL}" S4=$S4 bun --conditions=@exponetdb/source "$@" ); }
# cli_as NAME "scope scope..." [--targets t1,t2] : sign the CLI in as person NAME (humans/NAME.json; owner = state/owner.json) into $S4/cli/NAME
cli_as() {
  local name="$1" scopes="$2"; shift 2
  local cfg="$S4/cli/$name" f="$S4/humans/$name.json" out="$S4/cli/$name.out"
  [ "$name" = owner ] && f="${EXSTACK_STATE}/owner.json"
  mkdir -p "$cfg"; chmod 700 "$cfg" "$S4/cli"
  EXPONETDB_CONFIG_DIR="$cfg" "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_CLI_BIN}" profile add stack --server "${EXSTACK_PUBLIC_URL}" --use >/dev/null
  : >"$out"; chmod 600 "$out"
  ( EXPONETDB_CONFIG_DIR="$cfg" "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_CLI_BIN}" login --no-browser --scope "$scopes" >"$out" 2>&1 ) &
  local pid=$! url="" i
  for i in $(seq 1 60); do url="$(grep -Eo 'https?://[^ ]*/oauth/authorize\?[^ ]*' "$out" | head -1 || true)"; [ -n "$url" ] && break; sleep 0.5; done
  [ -n "$url" ] || { sed 's/code=[^& ]*/code=<r>/' "$out" >&2; kill $pid; return 1; }
  # shellcheck disable=SC2086
  EXSTACK_OWNER_FILE="$f" s4ts s4/consent.ts "$url" "$@" $scopes >&2
  wait $pid || { sed 's/code=[^& ]*/code=<r>/;s/state=[^& ]*/state=<s>/' "$out" >&2; return 1; }
  chmod -R go-rwx "$cfg"
}
# tok NAME -> prints nothing; writes the CLI access token of NAME to $S4/creds/NAME.token (0600)
tok() { mkdir -p "$S4/creds"; ( umask 077; jq -r '.credentials | to_entries[0].value.accessToken' "$S4/cli/$1/credentials.json" >"$S4/creds/$1.token" ); }
# refresh_creds: make the CLI refresh its access tokens (whoami), then rewrite $S4/creds/*.token for the CLI-based classes
refresh_creds() {
  local n
  for n in admin developer-nonprod developer-prod viewer oauth-narrow; do
    EXPONETDB_CONFIG_DIR="$S4/cli/$n" "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_CLI_BIN}" whoami >/dev/null 2>&1; tok $n
  done
  exdb whoami >/dev/null 2>&1
  ( umask 077; jq -r '.credentials | to_entries[0].value.accessToken' "${EXSTACK_STATE}/cli/credentials.json" >"$S4/creds/owner.token" )
}
# scan_stream SINK  (stdin = the sink's text)
scan_stream() { grep -aoF -f "$S4/patterns.txt" | python3 "$S4/attr.py" "$1"; }
# xdb NAME args... : the CLI as person NAME (cli/NAME config dir), JSON output
xdb() { local n="$1"; shift; EXPONETDB_CONFIG_DIR="$S4/cli/$n" "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_CLI_BIN}" "$@" 2>&1; }
xdbj() { local n="$1"; shift; EXPONETDB_CONFIG_DIR="$S4/cli/$n" "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_CLI_BIN}" "$@" --json 2>/dev/null; }
# rq PERSON name METHOD path [body]  : REST as the person's web session (reauth), prints one json line
rq() { local p="$1"; shift; local f="$S4/humans/$p.json"; [ "$p" = owner ] && f="${EXSTACK_STATE}/owner.json"; EXSTACK_OWNER_FILE="$f" s4ts s4/req.ts "$@" 2>&1 | tail -1; }
# bq TOKENFILE METHOD path [body] : REST with a bearer; prints status and code
bq() { local tf="$1" m="$2" p="$3" b="${4:-}"; local out; out=$(curl -s -m 60 -X "$m" -H "Authorization: Bearer $(cat $S4/creds/$tf.token)" -H 'content-type: application/json' ${b:+-d "$b"} -w '\n%{http_code}' "http://127.0.0.1:58480$p"); echo "$(echo "$out" | tail -1) $(echo "$out" | head -n -1 | jq -r '.code // empty' 2>/dev/null)"; }

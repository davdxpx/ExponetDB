#!/usr/bin/env bash
# MCP access token (audience mcp); writes the Authorization header to $1 (0600). See mcp-token.mjs.
# The authorization request must name the resource exactly as EXPONETDB_PUBLIC_URL spells it (localhost, not 127.0.0.1).
. /srv/work/s6-infra/s6/lib6.sh
EXSTACK_CONSENT_DAYS=${EXSTACK_CONSENT_DAYS:-7} node /srv/work/s6-infra/s6/mcp-token.mjs --api "${EXSTACK_PUBLIC_URL}" --out "${1:?header file}"

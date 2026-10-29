#!/usr/bin/env bash
# Re-point the registered cluster (pg17) at another PostgreSQL instance by endpoint: add the new endpoint, watch, retire the old one.
# usage: repoint.sh PORT TAG [OLD_PORT]
source /srv/work/s5/rehearsal/rh-lib.sh
NEW="${1:?new port}"; TAG="${2:?tag}"; OLDP="${3:-55417}"; cd "$PROJ"
CL=$(stack_id cluster_pg17)
echo "endpoints before:"; exdb_json cluster endpoints "$CL" | jq -r '.data.items[] | "  \(.id) \(.label) \(.host):\(.port) \(.state)"'
TAIL=14 tm "$TAG-endpoint-add" exdb cluster endpoint add "$CL" --label "$TAG" --kind private --host 127.0.0.1 --port "$NEW" --tls-server-name pg17.exdb.test --apply
echo "--- after the new endpoint exists:"
sleep 5; TAIL=12 tm "$TAG-target-show" exdb target show lab/platform/rhstg
TAIL=8 tm "$TAG-cluster-show" exdb cluster show "$CL"

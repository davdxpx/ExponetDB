# usage: labn-up.sh NAME  (creates container r1-NAME with systemd, node clusters; never touches other containers)
set -e
N=$1
docker rm -f r1-$N >/dev/null 2>&1 || true
docker run -d --name r1-$N --hostname r1-$N --privileged --cgroupns=private --network r1-net \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
  -v /srv/work/r1:/srv/work/r1 -v /usr/local:/usr/local:ro \
  r1-host-img /sbin/init >/dev/null
for i in $(seq 1 40); do st=$(docker exec r1-$N systemctl is-system-running 2>/dev/null || true); case "$st" in running|degraded) break;; esac; sleep 1; done
echo "systemd: $st"
docker exec r1-$N bash -c 'useradd --system --no-create-home --shell /usr/sbin/nologin exdbagent; EXDB_NODE_PG_VERSIONS=17 EXDB_NODE_AGENT_USER="root exdbagent" bash /srv/work/r1/new/tooling/dev/node-clusters.sh /root/exdb-node 2>&1 | tail -1'

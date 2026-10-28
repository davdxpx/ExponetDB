set -euo pipefail
. /srv/work/r2/ftlib.sh
apt-get install -y -q bc >/dev/null 2>&1 || true
mkdir -p /root/lab/logs /root/lab/walsave
ln -sfn /srv/work/r2/new /root/exdb
: > /root/lab/lab.env
cp /srv/work/r2/labsrc-scripts/*.sh /root/lab/
# the disposable cluster 17/exdbnode on 55417
mkdir -p /root/exdb-node
EXDB_NODE_PG_VERSIONS=17 EXDB_NODE_AGENT_USER="root exdbagent" bash /srv/work/r2/new/tooling/dev/node-clusters.sh /root/exdb-node > /root/exdb-node/env.txt 2>/root/exdb-node/err.txt
# labctl, built from the new tree in a scratch copy
rm -rf /srv/work/r2/labsrc && cp -r /srv/work/r2/new/agent/node /srv/work/r2/labsrc
mkdir -p /srv/work/r2/labsrc/cmd/zz-labctl && cp /srv/work/r2/labsrc-scripts/labctl.go /srv/work/r2/labsrc/cmd/zz-labctl/main.go
(cd /srv/work/r2/labsrc && go build -o /usr/local/bin/labctl ./cmd/zz-labctl)
labctl 2>&1 | head -2 || true
# install the release the way the runbook says (new tree's dist)
cd /srv/work/r2/dist-new
systemctl stop exponetdb-node-helper.socket exponetdb-node-helper.service 2>/dev/null || true
install -m0755 exponetdb-node-0.7.0-linux-amd64 /usr/bin/exponetdb-node
install -m0755 exponetdb-node-helper-0.7.0-linux-amd64 /usr/sbin/exponetdb-node-helper
install -m0644 systemd/exponetdb-node.service systemd/exponetdb-node-helper.service systemd/exponetdb-node-helper.socket /etc/systemd/system/
install -m0644 sysusers.d/exponetdb-node.conf /usr/lib/sysusers.d/
install -m0644 tmpfiles.d/exponetdb-node.conf tmpfiles.d/exponetdb-node-engine.conf /usr/lib/tmpfiles.d/
systemd-sysusers; systemd-tmpfiles --create
install -d -m0755 /etc/exponetdb-node /etc/exponetdb-node/repositories
python3 - <<'PY'
import json
inst=json.load(open('/root/exdb-node/clusters.json'))
cfg={"schema":"exponetdb.node-config/v1","stateDirectory":"/var/lib/exponetdb-node","helperSocket":"/run/exponetdb-node/helper.sock","agentUser":"exponetdb-node","disabledCapabilities":[],"instances":inst}
json.dump(cfg,open('/etc/exponetdb-node/config.json','w'),indent=2)
PY
chmod 0644 /etc/exponetdb-node/config.json
labctl trust /etc/exponetdb-node/helper-trust.json; chmod 0644 /etc/exponetdb-node/helper-trust.json
# pgBackRest, encrypted posix repository, archiving on 17/exdbnode
PASS=$(openssl rand -base64 33 | tr -d '\n'); echo -n "$PASS" > /root/lab/cipher.pass; chmod 600 /root/lab/cipher.pass
install -d -m0750 -o postgres -g postgres /var/lib/pgbackrest /var/log/pgbackrest; install -d -m0755 /etc/pgbackrest
cat > /etc/pgbackrest/pgbackrest.conf <<CONF
[global]
repo1-path=/var/lib/pgbackrest
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$PASS
repo1-retention-full=2
log-path=/var/log/pgbackrest
start-fast=y
archive-async=n
compress-type=zst
[exdbnode]
pg1-path=/var/lib/postgresql/17/exdbnode
pg1-port=55417
pg1-socket-path=/var/run/postgresql
CONF
chown root:postgres /etc/pgbackrest/pgbackrest.conf; chmod 0640 /etc/pgbackrest/pgbackrest.conf
cat > /etc/postgresql/17/exdbnode/conf.d/50-backup.conf <<CONF
archive_mode = on
archive_command = 'pgbackrest --stanza=exdbnode archive-push %p'
wal_level = replica
max_wal_size = 512MB
CONF
chown postgres:postgres /etc/postgresql/17/exdbnode/conf.d/50-backup.conf
pg_ctlcluster 17 exdbnode restart; sleep 2
runuser -u postgres -- pgbackrest --stanza=exdbnode stanza-create
runuser -u postgres -- pgbackrest --stanza=exdbnode check
runuser -u postgres -- psql -X -q -p 55417 -c "CREATE DATABASE app" postgres
runuser -u postgres -- psql -X -q -p 55417 -d app -c "CREATE EXTENSION amcheck; CREATE TABLE public.accounts (id int PRIMARY KEY, name text); CREATE INDEX ON public.accounts(name); INSERT INTO public.accounts SELECT g,'a'||g FROM generate_series(1,100) g"
systemctl daemon-reload
systemctl enable --now exponetdb-node-helper.socket
ls -l /run/exponetdb-node/
echo LAB-SETUP-OK

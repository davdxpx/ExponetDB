# runs INSIDE r1-host, once (or to reset): cluster 17/exdbnode, node config, pgBackRest, app db
set -euo pipefail
export PATH=$PATH:/usr/local/bin
EXDB_NODE_PG_VERSIONS=17 EXDB_NODE_AGENT_USER=exponetdb-node bash /srv/work/r1/new/tooling/dev/node-clusters.sh /root/exdb-node >/root/lab/logs/node-clusters.log 2>&1
python3 - <<'PY'
import json
inst=json.load(open('/root/exdb-node/clusters.json'))
cfg={"schema":"exponetdb.node-config/v1","stateDirectory":"/var/lib/exponetdb-node","helperSocket":"/run/exponetdb-node/helper.sock","agentUser":"exponetdb-node","disabledCapabilities":[],"instances":inst}
json.dump(cfg,open('/etc/exponetdb-node/config.json','w'),indent=2)
PY
chmod 0644 /etc/exponetdb-node/config.json
/opt/labctl trust /etc/exponetdb-node/helper-trust.json
chmod 0644 /etc/exponetdb-node/helper-trust.json
PASS=$(openssl rand -base64 33 | tr -d '\n')
echo -n "$PASS" > /root/lab/cipher.pass; chmod 600 /root/lab/cipher.pass
install -d -m0750 -o postgres -g postgres /var/lib/pgbackrest /var/log/pgbackrest
install -d -m0755 /etc/pgbackrest
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
mv /etc/pgbackrest.conf /etc/pgbackrest.conf.orig 2>/dev/null || true
cat > /etc/postgresql/17/exdbnode/conf.d/50-backup.conf <<CONF
archive_mode = on
archive_command = 'pgbackrest --stanza=exdbnode archive-push %p'
wal_level = replica
max_wal_size = 512MB
CONF
chown postgres:postgres /etc/postgresql/17/exdbnode/conf.d/50-backup.conf
pg_ctlcluster 17 exdbnode restart
sleep 2
runuser -u postgres -- pgbackrest --stanza=exdbnode stanza-create
runuser -u postgres -- pgbackrest --stanza=exdbnode check
runuser -u postgres -- psql -X -q -p 55417 -c "CREATE DATABASE app" postgres
runuser -u postgres -- psql -X -q -p 55417 -d app -c "CREATE EXTENSION amcheck; CREATE TABLE public.accounts (id int PRIMARY KEY, name text); CREATE INDEX ON public.accounts(name); INSERT INTO public.accounts SELECT g,'a'||g FROM generate_series(1,100) g"
systemctl daemon-reload
systemctl enable --now exponetdb-node-helper.socket
systemctl status exponetdb-node-helper.socket --no-pager | head -6
ls -l /run/exponetdb-node/

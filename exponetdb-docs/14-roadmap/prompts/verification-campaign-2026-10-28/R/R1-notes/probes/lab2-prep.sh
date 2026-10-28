# runs INSIDE r1-host2: engine dirs + pgBackRest on 17/exdbnode + app data + two full backups
set -euo pipefail
export PATH=$PATH:/usr/local/bin
D=/srv/work/r1/dist-new
install -m0644 $D/sysusers.d/exponetdb-node.conf /usr/lib/sysusers.d/
for f in $D/tmpfiles.d/*.conf; do install -m0644 $f /usr/lib/tmpfiles.d/; done
systemd-sysusers /usr/lib/sysusers.d/exponetdb-node.conf
systemd-tmpfiles --create /usr/lib/tmpfiles.d/exponetdb-node-engine.conf
[ -f /usr/lib/tmpfiles.d/exponetdb-node.conf ] && systemd-tmpfiles --create /usr/lib/tmpfiles.d/exponetdb-node.conf || true
install -d -m0755 /etc/exponetdb-node /etc/exponetdb-node/repositories
install -m0755 -o root -g root /usr/local/bin/restic /usr/bin/restic
mkdir -p /root/lab/logs /var/lib/c35
PASS=$(openssl rand -base64 33 | tr -d '\n'); echo -n "$PASS" > /root/lab/cipher.pass; chmod 600 /root/lab/cipher.pass
cp /root/lab/cipher.pass /var/lib/c35/pass; chown postgres: /var/lib/c35 /var/lib/c35/pass
install -d -m0750 -o postgres -g postgres /var/lib/pgbackrest /var/log/pgbackrest
install -d -m0755 /etc/pgbackrest
cat > /etc/pgbackrest/pgbackrest.conf <<CONF
[global]
repo1-path=/var/lib/pgbackrest
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$PASS
repo1-retention-full=4
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
pg_ctlcluster 17 exdbnode restart; sleep 2
runuser -u postgres -- pgbackrest --stanza=exdbnode stanza-create
runuser -u postgres -- pgbackrest --stanza=exdbnode check
P="runuser -u postgres -- psql -X -q -p 55417"
$P -c "CREATE DATABASE app" postgres
$P -d app -c "CREATE EXTENSION amcheck; CREATE TABLE public.accounts (id int PRIMARY KEY, name text); CREATE INDEX ON public.accounts(name); INSERT INTO public.accounts SELECT g,'a'||g FROM generate_series(1,100) g; CREATE TABLE public.filler AS SELECT g, repeat(md5(g::text),20) AS pad FROM generate_series(1,20000) g"
bk() { runuser -u postgres -- pgbackrest --stanza=exdbnode backup --type=full >/dev/null; }
bk; sleep 2
$P -d app -c "INSERT INTO public.accounts SELECT g,'m1_'||g FROM generate_series(1001,1010) g" -c "SELECT pg_switch_wal()" >/dev/null; sleep 2
bk; sleep 2
$P -d app -c "INSERT INTO public.accounts SELECT g,'m2_'||g FROM generate_series(2001,2010) g" -c "SELECT pg_switch_wal()" >/dev/null; sleep 2
bk; sleep 2
$P -d app -c "INSERT INTO public.accounts SELECT g,'m3_'||g FROM generate_series(3001,3010) g" -c "SELECT pg_switch_wal()" -c "SELECT pg_switch_wal()" >/dev/null
for i in 1 2 3 4 5 6; do runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -1 && break; sleep 2; done
runuser -u postgres -- pgbackrest --stanza=exdbnode info | grep -E "full backup|min/max"

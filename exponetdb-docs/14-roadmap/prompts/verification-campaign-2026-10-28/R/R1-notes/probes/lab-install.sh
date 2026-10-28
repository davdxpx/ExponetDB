# runs INSIDE r1-host. usage: lab-install.sh new|old
set -euo pipefail
export PATH=$PATH:/usr/local/bin
V=${1:-new}
ln -sfn /srv/work/r1/dist-$V /root/dist-0.7.0
cd /root/dist-0.7.0
systemctl stop exponetdb-node-helper.socket exponetdb-node-helper.service exponetdb-node.service 2>/dev/null || true
install -m0755 exponetdb-node-0.7.0-linux-amd64 /usr/bin/exponetdb-node
install -m0755 exponetdb-node-helper-0.7.0-linux-amd64 /usr/sbin/exponetdb-node-helper
install -m0644 systemd/exponetdb-node.service systemd/exponetdb-node-helper.service systemd/exponetdb-node-helper.socket /etc/systemd/system/
install -m0644 sysusers.d/exponetdb-node.conf /usr/lib/sysusers.d/
for f in tmpfiles.d/*.conf; do install -m0644 $f /usr/lib/tmpfiles.d/; done
mkdir -p /usr/share/doc/exponetdb-node && install -m0644 doc/node-runbook.md /usr/share/doc/exponetdb-node/
systemd-sysusers /usr/lib/sysusers.d/exponetdb-node.conf
systemd-tmpfiles --create /usr/lib/tmpfiles.d/exponetdb-node-engine.conf
[ -f /usr/lib/tmpfiles.d/exponetdb-node.conf ] && systemd-tmpfiles --create /usr/lib/tmpfiles.d/exponetdb-node.conf || true
install -d -m0755 /etc/exponetdb-node /etc/exponetdb-node/repositories
exponetdb-node-helper version; exponetdb-node version
install -m0755 /srv/work/r1/bin/labctl-$V /opt/labctl 2>/dev/null || { mkdir -p /opt; install -m0755 /srv/work/r1/bin/labctl-$V /opt/labctl; }
mkdir -p /root/lab/logs
touch /root/lab/lab.env

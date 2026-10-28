cd /srv/work/r2/new/agent/node/packaging
root=$(mktemp -d); mkdir -p $root/usr/lib/sysusers.d $root/usr/lib/tmpfiles.d $root/etc
cp sysusers.d/*.conf $root/usr/lib/sysusers.d/; cp tmpfiles.d/*.conf $root/usr/lib/tmpfiles.d/
systemd-sysusers --root=$root >/dev/null 2>&1; systemd-tmpfiles --root=$root --create >/dev/null 2>&1
echo "scratch passwd: $(grep '^exponetdb-node:' $root/etc/passwd | cut -d: -f1,3)"
echo "stat of the scratch directory: $(stat -c 'uid=%u name-by-host-NSS=%U mode=%a' $root/var/lib/exponetdb-node)"
echo "host passwd for that uid: $(getent passwd $(stat -c %u $root/var/lib/exponetdb-node) | cut -d: -f1 || true)"
rm -rf $root

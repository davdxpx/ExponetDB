. /srv/work/r2/ftlib.sh
ft_reset
for side in new old; do
  (cd /srv/work/r2/$side/agent/node && bash packaging/build.sh 0.7.0 /srv/work/r2/dist-$side > /srv/work/r2/logs/build-$side.log 2>&1; echo "build $side rc=$?"; tail -1 /srv/work/r2/logs/build-$side.log)
done
reset_host() {
  systemctl stop exponetdb-node.service exponetdb-node-helper.socket exponetdb-node-helper.service 2>/dev/null
  userdel exponetdb-node 2>/dev/null; groupdel exponetdb-node 2>/dev/null
  rm -rf /var/lib/exponetdb-node /var/lib/exponetdb-node-engine /etc/exponetdb-node /run/exponetdb-node /usr/lib/tmpfiles.d/exponetdb-node*.conf /usr/lib/sysusers.d/exponetdb-node.conf /usr/bin/exponetdb-node /usr/sbin/exponetdb-node-helper /etc/systemd/system/exponetdb-node* /root/token
}
literal() { # side
  side=$1; d=/srv/work/r2/dist-$side
  echo "=================== $side: the runbook section 2 and 3.3, literally"
  cd $d || return
  install -m 0755 exponetdb-node-0.7.0-linux-amd64 /usr/bin/exponetdb-node
  install -m 0755 exponetdb-node-helper-0.7.0-linux-amd64 /usr/sbin/exponetdb-node-helper
  install -m 0644 sysusers.d/exponetdb-node.conf /usr/lib/sysusers.d/
  systemd-sysusers
  if [ "$side" = new ]; then
    install -m 0644 tmpfiles.d/exponetdb-node.conf tmpfiles.d/exponetdb-node-engine.conf /usr/lib/tmpfiles.d/
    systemd-tmpfiles --create
    install -d -m 0755 /etc/exponetdb-node
    echo "state directory after tmpfiles: $(stat -c '%a %U:%G' /var/lib/exponetdb-node 2>&1)"
    echo "engine dirs: $(ls -d /var/lib/exponetdb-node-engine/* 2>&1 | tr '\n' ' ')"
  else
    install -m 0644 tmpfiles.d/exponetdb-node-engine.conf /usr/lib/tmpfiles.d/ 2>/dev/null
    mkdir -p /etc/exponetdb-node   # the old section 2 never created it; an operator must
    echo "state directory: $(stat -c '%a %U:%G' /var/lib/exponetdb-node 2>&1)"
  fi
  install -m 0644 systemd/exponetdb-node.service systemd/exponetdb-node-helper.service systemd/exponetdb-node-helper.socket /etc/systemd/system/
  systemctl daemon-reload
  python3 - <<'PY'
import json,os
p='/srv/work/r2/nodecl/clusters.json'
inst=json.load(open(p)) if os.path.exists(p) else []
cfg={"schema":"exponetdb.node-config/v1","stateDirectory":"/var/lib/exponetdb-node","helperSocket":"/run/exponetdb-node/helper.sock","agentUser":"exponetdb-node","disabledCapabilities":[],"instances":inst}
json.dump(cfg,open('/etc/exponetdb-node/config.json','w'),indent=2)
PY
  chmod 0644 /etc/exponetdb-node/config.json
  echo 'exdbt1.not-a-real-token' > /root/token; chmod 600 /root/token
  echo "--- enroll as the agent user, token from stdin (section 3.3 new text)"
  sudo -u exponetdb-node /usr/bin/exponetdb-node enroll --config /etc/exponetdb-node/config.json --token-file - < /root/token; echo "rc=$?"
  echo "--- enroll with --token-file /root/token (section 3.3 old text)"
  sudo -u exponetdb-node /usr/bin/exponetdb-node enroll --config /etc/exponetdb-node/config.json --token-file /root/token; echo "rc=$?"
}
reset_host; literal old
reset_host; literal new
reset_host
echo LABE1-DONE
